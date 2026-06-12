'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPinIcon, UsersIcon, CrosshairIcon, ZoomInIcon, ZoomOutIcon, SwordsIcon, TimerIcon, BellIcon } from 'lucide-react'
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
const REFRESH_INTERVAL_MS = 60_000 
const BOSS_RESPAWN_TIME_MS = 60 * 60 * 1000 // 1 Heure par défaut

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
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

function ControlRow({ label, checked, onCheckedChange }: { label: string, checked: boolean, onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 p-1">
      <span className="text-sm font-medium text-foreground/90">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} className="data-[state=checked]:bg-primary" />
    </div>
  )
}

function LiveCountdown({ targetDate }: { targetDate: string }) {
  const [timeLeft, setTimeLeft] = useState<string>('')

  useEffect(() => {
    const interval = setInterval(() => {
      const diff = new Date(targetDate).getTime() - Date.now()
      if (diff <= 0) {
        setTimeLeft('Prêt !')
        clearInterval(interval)
      } else {
        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
        const s = Math.floor((diff % (1000 * 60)) / 1000)
        setTimeLeft(`${m}m ${s}s`)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [targetDate])

  return <span>{timeLeft}</span>
}

export function LiveMap() {
  const { config, players, setPlayers } = useServer()
  
  const [zoom, setZoom] = useState(2)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [, setMousePosition] = useState<[string, string]>(['0.00', '0.00'])
  
  const [showPlayers, setShowPlayers] = useState(true)
  const [showBossTowers, setShowBossTowers] = useState(false)
  const [showFastTravels, setShowFastTravels] = useState(true)
  const [showBases, setShowBases] = useState(true)
  
  const [, setMapImageLoaded] = useState(false)
  const [, setMapImageError] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  
  const [bossTimers, setBossTimers] = useState<any[]>([])
  const [bases, setBases] = useState<any[]>([])
  
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'main', color: '#3b82f6' })

  const [isReportingBoss, setIsReportingBoss] = useState(false)
  const [bossFormName, setBossFormName] = useState('')

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(() => players.filter((player) => player.location_x !== 0 || player.location_y !== 0), [players])

  const fastTravelMarkers = useMemo(() => points.fast_travel.map((point) => ({
    key: `fast-travel-${point[0]}-${point[1]}`, position: toScreenPercent([point[0], point[1]])
  })), [])

  const bossTowerMarkers = useMemo(() => points.boss_tower.map((point) => ({
    key: `boss-tower-${point[0]}-${point[1]}`, 
    worldX: point[0], worldY: point[1],
    position: toScreenPercent([point[0], point[1]])
  })), [])

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

  const broadcastToChat = async (message: string) => {
    console.log("Envoi au chat du serveur :", message)
    try {
      await fetch('/api/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }) // Avec la clé 'message'
      })
    } catch (e) {
      console.error("Erreur d'envoi du message chat", e)
    }
  }

  const saveBase = async () => {
    if (!newBaseCoords || !formData.name) return
    const { error } = await supabase.from('player_bases').insert([{
      player_name: formData.name, guild_name: formData.faction, base_type: formData.type, 
      location_x: newBaseCoords.x, location_y: newBaseCoords.y, color_hex: formData.color
    }])
    if (!error) {
      setIsAddingBase(false); setNewBaseCoords(null); setFormData({ name: '', faction: '', type: 'main', color: '#3b82f6' })
    }
  }

  // --- CORRECTION: Formulaire de Boss ---
  const markBossDefeated = async () => {
      if (!bossFormName) return
      
      const bossName = bossFormName
      setIsReportingBoss(false)
      setBossFormName('')

      const respawnTime = new Date(Date.now() + BOSS_RESPAWN_TIME_MS).toISOString()
      const bossKey = `manual-boss-${Date.now()}`
      const newId = crypto.randomUUID() // Génération d'un UUID valide pour ta BDD

      // 1. Mise à jour immédiate
      const newTimer = { 
        id: newId, 
        boss_key: bossKey, 
        name: bossName, 
        respawn_time: respawnTime, 
        notified_respawn: false 
      }
      setBossTimers(prev => [...prev, newTimer])

      // 2. Sauvegarde en base de données avec l'ID inclus
      const { error } = await supabase.from('boss_timers').upsert([{ 
        id: newId,
        boss_key: bossKey,
        name: bossName,
        respawn_time: respawnTime,
        notified_respawn: false 
      }])

      if (error) console.error("Erreur d'enregistrement Supabase :", error)

      // 3. Envoi du message RCON
      broadcastToChat(`Le boss ${bossName} est vaincu. Respawn dans 1h !`)
    }

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date()
      bossTimers.forEach(async (timer) => {
        if (!timer.notified_respawn && new Date(timer.respawn_time) <= now) {
          broadcastToChat(`🔥 Le boss ${timer.name} est de nouveau disponible !`)
          await supabase.from('boss_timers').update({ notified_respawn: true }).eq('id', timer.id)
          fetchData()
        }
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [bossTimers, fetchData])

  const refreshPlayers = useCallback(async () => { /* Logique inchangée */ }, [config, setPlayers])

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

  const handleMapMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => { /* Logique inchangée */ }, [])
  
  const handleMapClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) return 
    if (!isAddingBase) return
    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return
    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    const mapX = -topRatio * 256; const mapY = leftRatio * 256
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

  const activeBossTimers = bossTimers.filter(t => new Date(t.respawn_time) > new Date())

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-4rem)] w-full overflow-hidden bg-background text-foreground relative font-sans">
        
        {/* Zone Principale de la Carte */}
        <div className="relative flex-1 w-full h-full overflow-hidden bg-[#1e2329]">
          <div
            className={`relative h-full w-full overflow-hidden ${isAddingBase && !newBaseCoords ? 'cursor-crosshair' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ overscrollBehavior: 'contain' }}
            onMouseMove={handleMapMouseMove} onMouseDown={handleMouseDown} onMouseUp={handleMapClick} onWheel={handleWheel}
            onContextMenu={(e) => { if (isAddingBase) e.preventDefault() }}
          >
            <div
              ref={mapPlaneRef} className="absolute left-1/2 top-1/2 will-change-transform"
              style={{ width: '1024px', height: '1024px', transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            >
              <img src={MAP_IMAGE_URL} alt="Carte du monde Palworld" className="block h-full w-full select-none" draggable={false} onLoad={() => { setMapImageLoaded(true); setMapImageError(false) }} onError={() => { setMapImageLoaded(false); setMapImageError(true) }} />

              {/* Fast Travels */}
              {showFastTravels && fastTravelMarkers.map((marker) => (
                <div 
                  key={marker.key} 
                  className="absolute z-10 flex items-center justify-center transition-transform hover:scale-110" 
                  style={{ ...marker.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                >
                  <img src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="h-6 w-6 object-contain drop-shadow-md" draggable={false} />
                </div>
              ))}

              {/* Bases des Joueurs */}
              {showBases && bases.map((base) => {
                const position = toScreenPercent([base.location_x, base.location_y])
                const isMain = base.base_type === 'main'
                return (
                  <div key={base.id} className="absolute z-20 flex flex-col items-center justify-center cursor-pointer group" style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}>
                    <img src="/palworld-map/pin-base.png" alt="Base" className={`drop-shadow-xl transition-all duration-300 group-hover:scale-125 object-contain ${isMain ? "h-14 w-14" : "h-8 w-8"}`} style={{ filter: `drop-shadow(0px 0px 8px ${base.color_hex || '#3b82f6'})` }} draggable={false} />
                    <span className="mt-1 whitespace-nowrap rounded-md bg-black/85 px-2.5 py-1 text-xs font-bold text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg backdrop-blur-sm border border-white/10">
                      {base.player_name}
                    </span>
                  </div>
                )
              })}

              {/* Tours */}
              {showBossTowers && bossTowerMarkers.map((point) => (
                <div 
                  key={point.key} 
                  className="absolute z-20 flex flex-col items-center justify-center cursor-pointer group" 
                  style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                >
                  <img 
                    src="/palworld-map/boss_tower.webp" 
                    alt="Tour" 
                    className="h-10 w-10 select-none object-contain transition-transform group-hover:scale-110 drop-shadow-xl" 
                    draggable={false} 
                  />
                </div>
              ))}

              {/* --- CORRECTION: Joueurs Actifs (Pseudo et pin collés) --- */}
              {showPlayers && mappablePlayers.map((player) => { 
                const position = toScreenPercent([player.location_x, player.location_y])
                
                return (
                  <div 
                    key={getPlayerKey(player)} 
                    className="absolute z-30 transition-transform duration-200 hover:scale-110 hover:z-40 flex flex-col items-center" 
                    style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}
                  >
                    {/* Nom au-dessus du pin avec marge négative pour l'effet collé */}
                    <div className="-mb-1.5 relative z-10 flex items-center justify-center rounded-md border border-primary/30 bg-background/80 px-2 py-0.5 shadow-lg backdrop-blur-sm">
                      <span className="whitespace-nowrap text-[11px] font-bold text-foreground drop-shadow-sm leading-tight">
                        {player.name}
                      </span>
                    </div>
                    {/* Pin en dessous */}
                    <img 
                      src="/palworld-map/pin-joueur.png" 
                      alt={player.name} 
                      className="relative z-0 h-10 w-10 select-none object-contain drop-shadow-md" 
                      draggable={false}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* --- CONTROLES FLOTTANTS (ZOOM) --- */}
        <div className="absolute bottom-6 right-6 z-50 flex flex-col gap-2">
          <Card className="bg-background/70 backdrop-blur-xl border-white/10 shadow-2xl overflow-hidden flex flex-col">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}>
              <ZoomInIcon className="h-5 w-5" />
            </Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}>
              <ZoomOutIcon className="h-5 w-5" />
            </Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => { setZoom(2); setPan({x:0, y:0}) }}>
              <CrosshairIcon className="h-4 w-4" />
            </Button>
          </Card>
        </div>

        {/* PANNEAU FLOTTANT GAUCHE */}
        <div className="absolute left-6 top-6 z-50 flex hidden w-[320px] flex-col gap-6 lg:flex max-h-[calc(100%-3rem)] overflow-y-auto pointer-events-none custom-scrollbar">
          <Card className="pointer-events-auto border-white/10 bg-background/60 p-5 text-foreground shadow-2xl backdrop-blur-xl rounded-2xl">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
              <MapPinIcon className="h-5 w-5 text-primary" /> Filtres de Carte
            </h3>
            <div className="space-y-2 rounded-xl border border-white/5 bg-black/20 p-4">
              <ControlRow label="Bases des joueurs" checked={showBases} onCheckedChange={setShowBases} />
              <ControlRow label="Tours" checked={showBossTowers} onCheckedChange={setShowBossTowers} />
              <ControlRow label="Points de téléportation" checked={showFastTravels} onCheckedChange={setShowFastTravels} />
              <ControlRow label="Afficher les joueurs" checked={showPlayers} onCheckedChange={setShowPlayers} />
            </div>
            
            <div className="mt-5 space-y-3">
              {!isAddingBase ? (
                <Button onClick={() => setIsAddingBase(true)} className="w-full gap-2 bg-primary/90 hover:bg-primary shadow-lg shadow-primary/20 transition-all rounded-xl">
                  <MapPinIcon className="h-4 w-4" /> Signaler ma base
                </Button>
              ) : (
                <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-center backdrop-blur-md">
                  <span className="text-xs text-red-400 font-bold block mb-3 animate-pulse">
                    Clic Droit sur la carte à l'emplacement exact !
                  </span>
                  <Button variant="outline" size="sm" className="w-full rounded-lg border-red-500/50 hover:bg-red-500/20" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null) }}>
                    Annuler
                  </Button>
                </div>
              )}
              
              <Button onClick={() => setIsReportingBoss(true)} className="w-full gap-2 bg-red-600/90 hover:bg-red-600 shadow-lg shadow-red-600/20 transition-all rounded-xl">
                <SwordsIcon className="h-4 w-4" /> Signaler un Boss vaincu
              </Button>
            </div>
          </Card>

          {/* BOSS EN COOLDOWN */}
          {activeBossTimers.length > 0 && (
            <Card className="pointer-events-auto border-white/10 bg-background/60 p-0 text-foreground shadow-2xl backdrop-blur-xl rounded-2xl overflow-hidden flex flex-col">
              <div className="p-4 border-b border-white/10 bg-gradient-to-r from-red-900/20 to-transparent flex items-center justify-between">
                <h3 className="font-bold text-sm flex items-center gap-2 text-red-400">
                  <BellIcon className="h-4 w-4" /> Boss en attente
                </h3>
                <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/10">{activeBossTimers.length}</Badge>
              </div>
              <div className="max-h-[250px] overflow-y-auto p-2 space-y-1">
                {activeBossTimers.map(timer => (
                  <div key={timer.id} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 text-sm">
                    <span className="font-semibold text-foreground/90 truncate mr-2">{timer.name}</span>
                    <span className="text-red-400 font-mono text-xs bg-red-500/10 px-2 py-1 rounded-md border border-red-500/20">
                      <LiveCountdown targetDate={timer.respawn_time} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>


      </div>

      {/* MODALS */}
      {newBaseCoords && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-white/10 bg-background/90 backdrop-blur-xl rounded-2xl">
            <h3 className="text-xl font-bold mb-4">Nouvelle Base</h3>
            <div className="space-y-4">
              <input type="text" className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="Nom du joueur / Guilde..." autoFocus />
              <select className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                <option value="main">⭐ Base Principale</option>
                <option value="sub_1">🏠 Base Secondaire 1</option>
              </select>
              <div className="flex gap-2 items-center">
                <input type="color" className="h-11 w-16 rounded-xl cursor-pointer bg-black/40 border border-white/10 p-1" value={formData.color} onChange={e => setFormData({...formData, color: e.target.value})} />
                <span className="text-sm text-muted-foreground">Couleur du halo</span>
              </div>
              <div className="flex gap-3 justify-end pt-4 border-t border-white/10">
                <Button variant="ghost" className="rounded-xl hover:bg-white/5" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null) }}>Annuler</Button>
                <Button className="rounded-xl" onClick={saveBase} disabled={!formData.name}>Déployer</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* MODAL DU FORMULAIRE DE BOSS */}
      {isReportingBoss && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-red-500/30 bg-background/90 backdrop-blur-xl rounded-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <SwordsIcon className="h-5 w-5 text-red-500" />
              </div>
              <h3 className="text-xl font-bold">Signaler un Boss Vaincu</h3>
            </div>
            
            <p className="text-sm text-muted-foreground mb-4">
              Un compte à rebours de 1 heure sera lancé et visible dans le tableau de bord.
            </p>

            <div className="space-y-4">
              <input 
                type="text" 
                className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-red-500 outline-none" 
                value={bossFormName} 
                onChange={e => setBossFormName(e.target.value)} 
                placeholder="Ex: Jetragon, Blazamut..." 
                autoFocus 
                onKeyDown={(e) => {
                  if (e.key === 'Enter') markBossDefeated()
                }}
              />

              <div className="flex gap-3 justify-end pt-4 border-t border-white/10">
                <Button variant="ghost" className="rounded-xl hover:bg-white/5" onClick={() => { setIsReportingBoss(false); setBossFormName('') }}>Annuler</Button>
                <Button className="rounded-xl bg-red-600 hover:bg-red-700 text-white" onClick={markBossDefeated}>
                  Signaler & Annoncer
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}