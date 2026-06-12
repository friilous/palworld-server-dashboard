'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPinIcon, UsersIcon } from 'lucide-react'
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
// Rafraîchissement silencieux toutes les 60 secondes
const REFRESH_INTERVAL_MS = 60_000 

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
  const { config, players, setPlayers } = useServer()
  
  const [zoom, setZoom] = useState(2)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [, setMousePosition] = useState<[string, string]>(['0.00', '0.00'])
  
  const [showPlayers, setShowPlayers] = useState(true)
  const [showBossTowers, setShowBossTowers] = useState(false)
  const [showFastTravels, setShowFastTravels] = useState(false)
  const [showBases, setShowBases] = useState(true)
  
  const [, setMapImageLoaded] = useState(false)
  const [, setMapImageError] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isPageVisible, setIsPageVisible] = useState(true)
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null)
  const [mapSize, setMapSize] = useState({ width: MAP_SIZE_FALLBACK, height: MAP_SIZE_FALLBACK })
  
  const [, setBossTimers] = useState<any[]>([])
  const [bases, setBases] = useState<any[]>([])
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'main', color: '#3b82f6' })

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)

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
    const { error } = await supabase.from('player_bases').insert([{
      player_name: formData.name, 
      guild_name: formData.faction,
      base_type: formData.type, 
      location_x: newBaseCoords.x,
      location_y: newBaseCoords.y, 
      color_hex: formData.color
    }])

    if (error) {
      alert("Erreur lors de la sauvegarde : " + error.message)
    } else {
      setIsAddingBase(false)
      setNewBaseCoords(null)
      setFormData({ name: '', faction: '', type: 'main', color: '#3b82f6' })
      fetchData()
    }
  }

  const refreshPlayers = useCallback(async () => {
    if (!config) return
    try {
      const response = await fetch(buildPalworldProxyPath('players'), {
        headers: { Accept: 'application/json', ...buildPalworldProxyHeaders(config) },
        cache: 'no-store',
      })
      if (response.ok) {
        const payload = await response.json()
        setPlayers(normalizePlayersPayload(payload))
      }
    } catch (e) {
      console.error("Erreur actualisation joueurs", e)
    }
  }, [config, setPlayers])

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
    void refreshPlayers()
    const interval = window.setInterval(() => { void refreshPlayers() }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [config, isPageVisible, refreshPlayers])

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
    if (event.button !== 2) return 
    if (!isAddingBase) return

    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return

    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    const mapX = -topRatio * 256
    const mapY = leftRatio * 256

    const [worldX, worldY] = fromMapPosition([mapX, mapY])
    setNewBaseCoords({ x: parseFloat(worldX), y: parseFloat(worldY) })
  }, [isAddingBase])

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

  const getCursorStyle = () => {
    if (isAddingBase && !newBaseCoords) return 'cursor-crosshair'
    return isDragging ? 'cursor-grabbing' : 'cursor-grab'
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] w-full overflow-hidden bg-background text-foreground relative">
      
      {/* Zone Principale de la Carte */}
      <div className="relative flex-1 w-full h-full overflow-hidden bg-background/40">
        <div
          className={`relative h-full w-full overflow-hidden ${getCursorStyle()}`}
          style={{ overscrollBehavior: 'contain' }}
          onMouseMove={handleMapMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMapClick}
          onContextMenu={(e) => { 
            if (isAddingBase) e.preventDefault() 
          }}
          onWheel={handleWheel}
        >
          <div
            ref={mapPlaneRef}
            className="absolute left-1/2 top-1/2 will-change-transform"
            style={{ 
              width: '1024px', 
              height: '1024px', 
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, 
              transformOrigin: 'center center' 
            }}
          >
            <img src={MAP_IMAGE_URL} alt="Carte du monde Palworld" className="block h-full w-full select-none" draggable={false} onLoad={() => { setMapImageLoaded(true); setMapImageError(false) }} onError={() => { setMapImageLoaded(false); setMapImageError(true) }} />

            {/* Bases des Joueurs */}
            {showBases && bases.map((base) => {
              const position = toScreenPercent([base.location_x, base.location_y])
              const labels: Record<string, string> = {
                'main': 'Principale',
                'sub_1': 'Secondaire 1',
                'sub_2': 'Secondaire 2',
                'sub_3': 'Secondaire 3'
              }
              const isMain = base.base_type === 'main'
              // Taille dynamique en fonction du type de base
              const imgSize = isMain ? "h-12 w-12" : "h-7 w-7"
              const label = labels[base.base_type] || base.base_type

              return (
                <div
                  key={base.id}
                  className="absolute z-20 flex flex-col items-center justify-center cursor-pointer group"
                  style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                >
                  {/* Image de la base */}
                  <img 
                    src="/palworld-map/pin-base.png" 
                    alt="Base" 
                    className={`drop-shadow-lg transition-transform group-hover:scale-110 object-contain ${imgSize}`} 
                    style={{ 
                      filter: `drop-shadow(0px 0px 4px ${base.color_hex || '#3b82f6'})` // Ajout d'une lueur de la couleur choisie
                    }}
                    draggable={false}
                  />
                  <span className="mt-1 whitespace-nowrap rounded bg-black/80 px-2 py-0.5 text-[10px] font-bold text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-sm border border-white/10">
                    {base.player_name} <span className="text-gray-400 font-normal">({label})</span>
                  </span>
                </div>
              )
            })}

            {/* Marqueurs */}
            {showFastTravels && fastTravelMarkers.map((point) => (
              <img key={point.key} src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="absolute z-20 h-7 w-7 select-none object-contain drop-shadow-md" style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} draggable={false} />
            ))}
            

            {showBossTowers && bossTowerMarkers.map((point) => (
              <img key={point.key} src="/palworld-map/boss_tower.webp" alt="Boss Tower" className="absolute z-20 h-10 w-10 select-none object-contain drop-shadow-lg" style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} draggable={false} />
            ))}

            {/* Joueurs Actifs */}
            {showPlayers && playerGroups.map((group) => {
              const isHovered = hoveredGroupId === group.id
              return (
                <div key={group.id}>
                  {group.players.map(({ player, x, y }, index) => {
                    const offset = getFanoutOffset(index, group.players.length, scale)
                    return (
                      <div 
                        key={getPlayerKey(player)} 
                        className={`absolute ${isHovered ? 'z-40' : 'z-30'} transition-transform duration-200 hover:scale-110`} 
                        style={{ left: `${x}px`, top: `${y}px` }} 
                        onMouseEnter={() => setHoveredGroupId(group.id)}
                        onMouseLeave={() => setHoveredGroupId(null)}
                      >
                        <img 
                          src="/palworld-map/pin-joueur.png" 
                          alt={player.name} 
                          className="absolute left-0 top-0 h-10 w-10 -translate-x-1/2 -translate-y-1/2 select-none object-contain drop-shadow-md" 
                          style={{ transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                          draggable={false}
                        />
                        <div className="absolute left-0 top-0" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${1 / scale})`, transformOrigin: 'center bottom' }}>
                          <div className="absolute left-0 top-0 flex items-center justify-center rounded-md border border-primary/30 bg-background/80 px-2.5 py-1 shadow-lg backdrop-blur-sm" style={{ transform: 'translate(-50%, calc(-100% - 20px))' }}>
                            <span className="whitespace-nowrap text-xs font-bold text-foreground drop-shadow-sm">{player.name}</span>
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

        {/* PANNEAU FLOTTANT GAUCHE : Filtres & Bases */}
        <div className="absolute left-4 top-4 z-50 flex hidden w-80 flex-col gap-4 lg:flex max-h-[calc(100%-2rem)] overflow-y-auto pointer-events-none">
          
          <Card className="pointer-events-auto border-border/60 bg-card/85 p-4 text-foreground shadow-2xl shadow-black/20 backdrop-blur">
            <h3 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <MapPinIcon className="h-5 w-5 text-primary" />
              Légende & Filtres
            </h3>
            <div className="space-y-3 rounded-xl border border-border/60 bg-muted/35 p-4">
              <ControlRow label="Points de téléportation" checked={showFastTravels} onCheckedChange={setShowFastTravels} />
              <ControlRow label="Tours de Boss" checked={showBossTowers} onCheckedChange={setShowBossTowers} />
              <ControlRow label="Afficher les joueurs" checked={showPlayers} onCheckedChange={setShowPlayers} />
              <ControlRow label="Bases des joueurs" checked={showBases} onCheckedChange={setShowBases} />
            </div>
          </Card>

          <Card className="pointer-events-auto border-border/60 bg-card/85 p-4 text-foreground shadow-2xl shadow-black/20 backdrop-blur">
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
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-center">
                  <span className="text-xs text-red-500 font-bold block mb-2 animate-pulse">
                    Faites un clic droit sur la carte à l'emplacement exact !
                  </span>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null) }}>
                    Annuler l'action
                  </Button>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* PANNEAU FLOTTANT DROIT : Joueurs en Ligne */}
        <div className="absolute right-4 top-4 z-50 flex hidden w-72 flex-col lg:flex max-h-[calc(100%-2rem)] pointer-events-none">
          <Card className="pointer-events-auto flex flex-col border-border/60 bg-card/85 text-foreground shadow-2xl shadow-black/20 backdrop-blur max-h-full">
            <div className="p-4 border-b border-border/60 flex items-center justify-between bg-muted/20">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <UsersIcon className="h-5 w-5 text-primary" />
                En Ligne
              </h3>
              <Badge variant="secondary" className="bg-primary/20 text-primary">{players.length}</Badge>
            </div>
            
            <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
              {players.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  Aucun explorateur connecté.
                </div>
              ) : (
                [...players].sort((a, b) => (b.level || 0) - (a.level || 0)).map((p) => (
                  <div key={getPlayerKey(p)} className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors border border-transparent hover:border-border/50">
                    <div className="h-10 w-10 shrink-0 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <img src="/palworld-map/pin-joueur.png" alt="Avatar" className="h-6 w-6 object-contain" />
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
      </div>

      {/* MODAL : Formulaire d'ajout de base */}
      {newBaseCoords && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-primary/50 bg-card">
            <h3 className="text-xl font-bold mb-2">Enregistrer ma base</h3>
            
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Nom de la base ou du joueur</label>
                <input 
                  type="text"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" 
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  placeholder="Ex: Vos pseudos..."
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Type de base</label>
                <select
                  className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={formData.type}
                  onChange={e => setFormData({...formData, type: e.target.value})}
                >
                  <option value="main">⭐ Base Principale</option>
                  <option value="sub_1">🏠 Base Secondaire 1</option>
                  <option value="sub_2">🏠 Base Secondaire 2</option>
                  <option value="sub_3">🏠 Base Secondaire 3</option>
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