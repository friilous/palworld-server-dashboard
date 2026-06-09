'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MinusIcon, PlusIcon, RefreshCwIcon, MapPinIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { buildPalworldProxyHeaders, buildPalworldProxyPath, getPlayerKey, normalizePlayersPayload } from '@/lib/palworld'
import { useServer } from '@/lib/server-context'
import type { Player } from '@/lib/types'
import points from '@/lib/map-points.json'
import { supabase } from '@/lib/supabase'

// --- CONSTANTES ET UTILS ---
const LANDSCAPE = [447900, 708920, -999940, -738920] as const
const MAP_IMAGE_URL = '/palworld-map/full-map-z4.png'
const MIN_ZOOM = 0
const MAX_ZOOM = 10
const MAP_SIZE_FALLBACK = 920
const REFRESH_INTERVAL_MS = 5_000

interface PlayerMarkerGroup {
  id: string
  players: Array<{
    player: Player & { level?: number }
    x: number
    y: number
  }>
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getFanoutOffset(index: number, count: number, scale: number) {
  if (count <= 1) return { x: 0, y: 0 }
  const radius = (count <= 3 ? 22 : count <= 6 ? 30 : 38) / scale
  const angleOffset = count === 2 ? Math.PI / 2 : -Math.PI / 2
  const angle = angleOffset + (index / count) * Math.PI * 2
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function toMapPosition([worldX, worldY]: [number, number]): [number, number] {
  if (worldX >= -256 && worldX <= 256) return [worldX, worldY]
  const x = -256 + (256 * (worldX - LANDSCAPE[2])) / (LANDSCAPE[0] - LANDSCAPE[2])
  const y = (256 * (worldY - LANDSCAPE[3])) / (LANDSCAPE[1] - LANDSCAPE[3])
  return [x, y]
}

function fromMapPosition([mapX, mapY]: [number, number]): [string, string] {
  const worldX = ((mapX + 256) * (LANDSCAPE[0] - LANDSCAPE[2])) / 256 + LANDSCAPE[2]
  const worldY = (mapY * (LANDSCAPE[1] - LANDSCAPE[3])) / 256 + LANDSCAPE[3]
  return [worldX.toFixed(2), worldY.toFixed(2)]
}

function toScreenPercent(position: [number, number]) {
  const [mapX, mapY] = toMapPosition(position)
  return { left: `${(mapY / 256) * 100}%`, top: `${(-mapX / 256) * 100}%` }
}

function toScreenPixels(position: [number, number], width: number, height: number) {
  const [mapX, mapY] = toMapPosition(position)
  return { x: (mapY / 256) * width, y: (-mapX / 256) * height }
}

function ControlRow({ label, checked, onCheckedChange }: { label: string, checked: boolean, onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function LiveMap() {
  const { config, connectionStatus, players, setPlayers } = useServer()
  
  // États Globaux
  const [zoom, setZoom] = useState(2)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [mousePosition, setMousePosition] = useState<[string, string]>(['0.00', '0.00'])
  
  // Toggles d'affichage
  const [showPlayers, setShowPlayers] = useState(true)
  const [showBossTowers, setShowBossTowers] = useState(false)
  const [showFastTravels, setShowFastTravels] = useState(false)
  const [showBases, setShowBases] = useState(true)
  
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshCountdownMs, setRefreshCountdownMs] = useState(REFRESH_INTERVAL_MS)
  const [mapImageLoaded, setMapImageLoaded] = useState(false)
  const [mapImageError, setMapImageError] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isPageVisible, setIsPageVisible] = useState(true)
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null)
  const [mapSize, setMapSize] = useState({ width: MAP_SIZE_FALLBACK, height: MAP_SIZE_FALLBACK })
  
  // États Supabase / Ajout de base
  const [bossTimers, setBossTimers] = useState<any[]>([])
  const [bases, setBases] = useState<any[]>([])
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'principale', color: '#3b82f6' })

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)
  const nextAutoRefreshAtRef = useRef<number | null>(null)

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(
    () => players.filter((player) => player.location_x !== 0 || player.location_y !== 0),
    [players]
  )

  const fastTravelMarkers = useMemo(
    () => points.fast_travel.map((point) => ({
      key: `fast-travel-${point[0]}-${point[1]}`,
      position: toScreenPercent([point[0], point[1]]),
    })),
    []
  )

  const bossTowerMarkers = useMemo(
    () => points.boss_tower.map((point) => ({
      key: `boss-tower-${point[0]}-${point[1]}`,
      position: toScreenPercent([point[0], point[1]]),
    })),
    []
  )

  const fetchData = useCallback(async () => {
    const [basesRes, timersRes] = await Promise.all([
      supabase.from('player_bases').select('*'),
      supabase.from('boss_timers').select('*')
    ])
    if (basesRes.data) setBases(basesRes.data)
    if (timersRes.data) setBossTimers(timersRes.data)
  }, [])

  useEffect(() => {
    fetchData()
    const channel = supabase.channel('realtime-db')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_bases' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'boss_timers' }, fetchData)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [fetchData])

  const saveBase = async () => {
    if (!newBaseCoords || !formData.name) return
    await supabase.from('player_bases').insert([{
      player_name: formData.name, 
      guild_name: formData.faction,
      base_type: formData.type, 
      location_x: newBaseCoords.x,
      location_y: newBaseCoords.y, 
      color_hex: formData.color
    }])
    setIsAddingBase(false)
    setNewBaseCoords(null)
    setFormData({ name: '', faction: '', type: 'principale', color: '#3b82f6' })
    fetchData()
  }

  const refreshPlayers = useCallback(async () => {
    if (!config) return
    const response = await fetch(buildPalworldProxyPath('players'), {
      headers: { Accept: 'application/json', ...buildPalworldProxyHeaders(config) },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('Échec de récupération')
    const payload = await response.json()
    setPlayers(normalizePlayersPayload(payload))
  }, [config, setPlayers])

  const refreshMap = useCallback(async () => {
    setIsRefreshing(true)
    try { await refreshPlayers() } finally { setIsRefreshing(false) }
  }, [refreshPlayers])

  useEffect(() => {
    const updateVisibility = () => setIsPageVisible(!document.hidden)
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    const element = mapPlaneRef.current
    if (!element) return
    const updateSize = () => {
      setMapSize({ width: element.clientWidth || MAP_SIZE_FALLBACK, height: element.clientHeight || MAP_SIZE_FALLBACK })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!config || !isPageVisible) return
    const scheduleNextRefresh = () => {
      nextAutoRefreshAtRef.current = Date.now() + REFRESH_INTERVAL_MS
      setRefreshCountdownMs(REFRESH_INTERVAL_MS)
    }
    scheduleNextRefresh()
    void refreshMap()
    const interval = window.setInterval(() => { scheduleNextRefresh(); void refreshMap() }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [config, isPageVisible, refreshMap])

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (event: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      setPan({ x: start.panX + (event.clientX - start.x), y: start.panY + (event.clientY - start.y) })
    }
    const handleMouseUp = () => { dragStartRef.current = null; setIsDragging(false) }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [isDragging])

  const handleMapMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return
    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    const mapX = -topRatio * 256
    const mapY = leftRatio * 256
    setMousePosition(fromMapPosition([mapX, mapY]))
  }, [])

  const handleMapClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Évite d'agir si c'est un clic droit (event.button === 2) ou si on déplace la carte
    if (event.button !== 0) return 
    if (!isAddingBase || isDragging) return

    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return

    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    const mapX = -topRatio * 256
    const mapY = leftRatio * 256

    const [worldX, worldY] = fromMapPosition([mapX, mapY])
    setNewBaseCoords({ x: parseFloat(worldX), y: parseFloat(worldY) })
  }, [isAddingBase, isDragging])

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setZoom((current) => clamp(current + (event.deltaY < 0 ? 1 : -1), MIN_ZOOM, MAX_ZOOM))
  }, [])

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    setIsDragging(true)
  }, [pan.x, pan.y])

  const playerGroups = useMemo(() => {
    if (mappablePlayers.length === 0) return [] as PlayerMarkerGroup[]
    const shouldUngroup = zoom >= 6
    const thresholdPx = shouldUngroup ? 0 : (38 * (1 - zoom / 6)) / scale
    const positionedPlayers = mappablePlayers.map((player) => ({
      player,
      ...toScreenPixels([player.location_x, player.location_y], mapSize.width, mapSize.height),
    }))
    const visited = new Set<number>()
    const groups: PlayerMarkerGroup[] = []

    for (let i = 0; i < positionedPlayers.length; i += 1) {
      if (visited.has(i)) continue
      const queue = [i]
      const memberIndexes: number[] = []
      visited.add(i)

      while (queue.length > 0) {
        const currentIndex = queue.shift()
        if (currentIndex === undefined) continue
        memberIndexes.push(currentIndex)
        const current = positionedPlayers[currentIndex]

        for (let j = 0; j < positionedPlayers.length; j += 1) {
          if (visited.has(j)) continue
          const candidate = positionedPlayers[j]
          const distance = Math.hypot(candidate.x - current.x, candidate.y - current.y)
          if (!shouldUngroup && distance <= thresholdPx) {
            visited.add(j); queue.push(j)
          }
        }
      }
      const members = memberIndexes.map((index) => positionedPlayers[index])
      groups.push({
        id: members.map((member) => getPlayerKey(member.player)).join('|'),
        players: members.map((member) => ({ player: member.player, x: member.x, y: member.y })),
      })
    }
    return groups
  }, [mapSize.height, mapSize.width, mappablePlayers, scale, zoom])

  const refreshLabel = useMemo(() => {
    if (!config) return 'Actu: --'
    if (!isPageVisible) return 'Actu: En pause'
    return `Actu: ${Math.max(0, Math.ceil(refreshCountdownMs / 1000))}s`
  }, [config, isPageVisible, refreshCountdownMs])

  const getCursorStyle = () => {
    if (isAddingBase && !newBaseCoords) return 'cursor-crosshair'
    return isDragging ? 'cursor-grabbing' : 'cursor-grab'
  }

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground relative">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 bg-card/70 p-4 backdrop-blur">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold">
            <span>Carte du Maraudeur</span>
            <span className="relative inline-flex h-2.5 w-2.5">
              <span className="status-dot absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="status-dot relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Vue satellite en temps réel avec position et statut des joueurs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="bg-primary/15 text-primary hover:bg-primary/15">{refreshLabel}</Badge>
          <Badge variant="secondary" className="border border-border/60 bg-muted/40 text-foreground">{connectionStatus}</Badge>
          <Badge variant="secondary" className="border border-border/60 bg-muted/40 text-foreground">Joueurs: {players.length}</Badge>
          <Button size="icon" variant="outline" className="border-border/70" onClick={() => void refreshMap()} disabled={isRefreshing || !config}>
            <RefreshCwIcon className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Grid Layout Principal */}
      <div className="grid flex-1 grid-cols-1 gap-4 p-4 xl:grid-cols-[20rem_minmax(0,1fr)_20rem] lg:grid-cols-[20rem_minmax(0,1fr)]">
        
        {/* COLONNE 1 : Contrôles & Ajout de Base (Gauche) */}
        <div className="flex flex-col gap-4">
          <Card className="border-border/60 bg-card/85 p-4 text-foreground shadow-2xl shadow-black/20 backdrop-blur lg:h-fit">
            <div className="space-y-4">
              <div className="rounded-xl border border-border/60 bg-muted/35 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Niveau de Zoom</div>
                <div className="mt-1 text-2xl font-semibold">{zoom + 1}x</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {zoom >= 6 ? 'Joueurs dissociés' : 'Le regroupement s\'estompe en zoomant'}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/60 bg-muted/35 p-4">
                <ControlRow label="Points de téléportation" checked={showFastTravels} onCheckedChange={setShowFastTravels} />
                <ControlRow label="Tours de Boss" checked={showBossTowers} onCheckedChange={setShowBossTowers} />
                <ControlRow label="Afficher les joueurs" checked={showPlayers} onCheckedChange={setShowPlayers} />
                <ControlRow label="Bases des joueurs" checked={showBases} onCheckedChange={setShowBases} />
              </div>

              <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Position GPS</span>
                <span className="font-mono text-foreground">{mousePosition[0]}, {mousePosition[1]}</span>
              </div>

              <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/45 px-3 py-4 shadow-xl">
                <Button size="icon" variant="ghost" onClick={() => setZoom((current) => clamp(current + 1, MIN_ZOOM, MAX_ZOOM))}>
                  <PlusIcon className="h-4 w-4" />
                </Button>
                <div className="graph-line-rounded flex h-2 flex-1 items-center rounded-full bg-muted/45 p-[2px]">
                  <div className="graph-line-rounded h-full rounded-full bg-primary transition-all" style={{ width: `${((zoom + 1) / (MAX_ZOOM + 1)) * 100}%` }} />
                </div>
                <Button size="icon" variant="ghost" onClick={() => setZoom((current) => clamp(current - 1, MIN_ZOOM, MAX_ZOOM))}>
                  <MinusIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>

          {/* NOUVEAU BLOC : Gestion des Bases */}
          <Card className="border-border/60 bg-card/85 p-4 text-foreground shadow-2xl shadow-black/20 backdrop-blur">
            <h3 className="font-semibold text-lg mb-2">Vos Bases</h3>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ajoutez vos bases pour les partager avec la communauté.
              </p>
              
              {!isAddingBase ? (
                <Button onClick={() => setIsAddingBase(true)} className="w-full gap-2">
                  <MapPinIcon className="h-4 w-4" /> Signaler ma base
                </Button>
              ) : (
                <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-center">
                  <span className="text-xs text-primary font-medium block mb-2 animate-pulse">
                    Faites un clic gauche sur la carte à l'emplacement exact !
                  </span>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null) }}>
                    Annuler l'action
                  </Button>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* COLONNE 2 : Carte (Centre) */}
        <div className="flex min-w-0 h-full">
          <div className="relative flex flex-1 w-full min-h-[60vh] items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-card/40">
            <div
              className={`relative aspect-square overflow-hidden rounded-2xl border border-border/60 bg-background/40 shadow-2xl shadow-black/20 ${getCursorStyle()}`}
              style={{ width: 'min(100%, 920px)', overscrollBehavior: 'contain' }}
              onMouseMove={handleMapMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMapClick}
              onWheel={handleWheel}
            >
              <div
                ref={mapPlaneRef}
                className="absolute left-1/2 top-1/2 h-full w-full will-change-transform"
                style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
              >
                <img src={MAP_IMAGE_URL} alt="Carte du monde Palworld" className="block h-full w-full select-none object-cover" draggable={false} onLoad={() => { setMapImageLoaded(true); setMapImageError(false) }} onError={() => { setMapImageLoaded(false); setMapImageError(true) }} />

                {/* Bases des Joueurs */}
                {showBases && bases.map((base) => {
                  const position = toScreenPercent([base.location_x, base.location_y])
                  return (
                    <div
                      key={base.id || `${base.location_x}-${base.location_y}`}
                      className="absolute z-20 flex flex-col items-center justify-center"
                      style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                      title={`${base.player_name} (${base.base_type})`}
                    >
                      <div className={`h-6 w-6 rounded-sm border-2 border-black/80 shadow-lg ${base.base_type === 'principale' ? 'rounded-md' : 'rounded-full'}`} style={{ backgroundColor: base.color_hex || '#3b82f6' }} />
                      {zoom >= 4 && (
                        <span className="mt-1 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold text-white backdrop-blur">
                          {base.player_name}
                        </span>
                      )}
                    </div>
                  )
                })}

                {/* Marqueurs */}
                {showFastTravels && fastTravelMarkers.map((point) => (
                  <img key={point.key} src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="absolute z-20 h-7 w-7 select-none object-contain drop-shadow-md" style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} draggable={false} />
                ))}
                {showBossTowers && bossTowerMarkers.map((point) => (
                  <img key={point.key} src="/palworld-map/boss_tower.webp" alt="Boss Tower" className="absolute z-20 h-8 w-8 select-none object-contain drop-shadow-lg" style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} draggable={false} />
                ))}

                {/* Joueurs Actifs */}
                {showPlayers && playerGroups.map((group) => {
                  const isHovered = hoveredGroupId === group.id
                  return (
                    <div key={group.id}>
                      {group.players.map(({ player, x, y }, index) => {
                        const offset = getFanoutOffset(index, group.players.length, scale)
                        return (
                          <div key={getPlayerKey(player)} className={`absolute ${isHovered ? 'z-40' : 'z-30'}`} style={{ left: `${x}px`, top: `${y}px` }} onMouseEnter={() => setHoveredGroupId(group.id)} onMouseLeave={() => setHoveredGroupId(null)}>
                            <div className="pointer-events-none absolute left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-red-500 bg-red-600/80 shadow-[0_0_8px_rgba(239,68,68,0.8)]" style={{ transform: `translate(-50%, -50%) scale(${1 / scale})` }} />
                            <img src="/palworld-map/player.webp" alt="" className="absolute left-0 top-0 h-8 w-8 -translate-x-1/2 -translate-y-1/2 select-none object-contain drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)]" style={{ transform: `translate(-50%, -50%) scale(${1 / scale})` }} draggable={false} />
                            <div className="absolute left-0 top-0" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${1 / scale})`, transformOrigin: 'center bottom' }}>
                              <div className="absolute left-0 top-0 flex flex-col items-center justify-center min-w-[85px] rounded-lg border border-border/50 bg-black/75 px-2 py-1.5 shadow-2xl backdrop-blur-md" style={{ transform: 'translate(-50%, calc(-100% - 16px))' }}>
                                <span className="whitespace-nowrap text-xs font-bold text-amber-400">{player.name}</span>
                                <div className="mt-0.5 text-[10px] font-semibold text-gray-300">Niv. {player.level || '?'}</div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* COLONNE 3 : Liste des joueurs (Droite) */}
        <Card className="flex flex-col border-border/60 bg-card/85 text-foreground shadow-2xl shadow-black/20 backdrop-blur lg:h-fit xl:h-full max-h-[80vh]">
          <div className="p-4 border-b border-border/60 flex items-center justify-between">
            <h3 className="font-semibold text-lg">Joueurs en ligne</h3>
            <Badge variant="secondary" className="bg-primary/20 text-primary">{players.length}</Badge>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {players.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Aucun joueur actuellement connecté au serveur.
              </div>
            ) : (
              players.map((p) => (
                <div key={getPlayerKey(p)} className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50">
                  <div className="h-10 w-10 shrink-0 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-lg">
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-bold truncate text-foreground">{p.name}</span>
                    <span className="text-xs text-muted-foreground">Niveau {p.level || '?'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

      </div>

      {/* MODAL : Formulaire d'ajout de base (Déplacé à la racine pour éviter les conflits de clic/focus avec la carte) */}
      {newBaseCoords && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-primary/50 bg-card">
            <h3 className="text-xl font-bold mb-2">Enregistrer ma base</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Position GPS: X: {newBaseCoords.x.toFixed(0)} | Y: {newBaseCoords.y.toFixed(0)}
            </p>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Nom de la base ou du joueur</label>
                <input 
                  type="text"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" 
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  placeholder="Ex: Forteresse de Kévin"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Type de base</label>
                <select
                  className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={formData.type}
                  onChange={e => setFormData({...formData, type: e.target.value})}
                >
                  <option value="principale">Base Principale (Carré)</option>
                  <option value="secondaire">Base Secondaire / Minage (Rond)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Couleur sur la carte</label>
                <div className="flex gap-2">
                  <input 
                    type="color" 
                    className="h-10 w-16 rounded cursor-pointer bg-background border border-input p-1"
                    value={formData.color}
                    onChange={e => setFormData({...formData, color: e.target.value})}
                  />
                  <span className="text-xs text-muted-foreground flex items-center">Choisis ta couleur !</span>
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-4 border-t border-border">
                <Button variant="ghost" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null) }}>Annuler</Button>
                <Button onClick={saveBase} disabled={!formData.name}>Sauvegarder</Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}