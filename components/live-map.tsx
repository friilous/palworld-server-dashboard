'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPinIcon, ZoomInIcon, ZoomOutIcon, CrosshairIcon, SwordsIcon, BellIcon, TrashIcon, XIcon, MoveIcon, StarIcon, HomeIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getPlayerKey } from '@/lib/palworld'
import { useServer } from '@/lib/server-context'
import points from '@/lib/map-points.json'
import { supabase } from '@/lib/supabase'


const BASE_RADIUS = 8000; 
const PLAYER_CLUSTER_RADIUS = 8000;


const LANDSCAPE = [447900, 708920, -999940, -738920] as const
const MAP_IMAGE_URL = '/palworld-map/full-map-z4.png'
const MIN_ZOOM = 0
const MAX_ZOOM = 10
const BOSS_RESPAWN_TIME_MS = 60 * 60 * 1000 // 1 Heure

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
  const { players } = useServer()
  
  const [zoom, setZoom] = useState(2)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [mousePosition, setMousePosition] = useState<[string, string]>(['0.00', '0.00'])
  
  const [showPlayers, setShowPlayers] = useState(true)
  const [showBossTowers, setShowBossTowers] = useState(false)
  const [showFastTravels, setShowFastTravels] = useState(true)
  const [showBases, setShowBases] = useState(true)
  
  const [isDragging, setIsDragging] = useState(false)
  
  const [bossTimers, setBossTimers] = useState<any[]>([])
  const [bases, setBases] = useState<any[]>([])
  
  // États de gestion des bases
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'main', isUnknown: false })
  
  const [selectedBase, setSelectedBase] = useState<any | null>(null)
  const [claimData, setClaimData] = useState({ name: '', type: 'main' })
  const [movingBaseId, setMovingBaseId] = useState<string | null>(null)

  const [isReportingBoss, setIsReportingBoss] = useState(false)
  const [bossFormName, setBossFormName] = useState('')

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(() => players.filter((player) => player.location_x !== 0 || player.location_y !== 0), [players])

  const { basesWithPlayers, clusteredPlayers } = useMemo(() => {
      const basesData = bases.map(b => ({ ...b, players: [] as typeof mappablePlayers }))
      const remainingPlayers: typeof mappablePlayers = []

      mappablePlayers.forEach(player => {
        let inBase = false
        for (let base of basesData) {
          const dist = Math.hypot(player.location_x - base.location_x, player.location_y - base.location_y)
          if (dist < BASE_RADIUS) {
            base.players.push(player)
            inBase = true
            break
          }
        }
        if (!inBase) remainingPlayers.push(player)
      })

      const clusters: { id: string, x: number, y: number, players: typeof mappablePlayers }[] = []
      
      remainingPlayers.forEach(player => {
        let addedToCluster = false
        for (let cluster of clusters) {
          const dist = Math.hypot(player.location_x - cluster.x, player.location_y - cluster.y)
          if (dist < PLAYER_CLUSTER_RADIUS) {
            cluster.players.push(player)
            cluster.x = (cluster.x * (cluster.players.length - 1) + player.location_x) / cluster.players.length
            cluster.y = (cluster.y * (cluster.players.length - 1) + player.location_y) / cluster.players.length
            addedToCluster = true
            break
          }
        }
        if (!addedToCluster) {
          clusters.push({ id: `cluster-${player.name}`, x: player.location_x, y: player.location_y, players: [player] })
        }
      })

      return { basesWithPlayers: basesData, clusteredPlayers: clusters }
    }, [mappablePlayers, bases])

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

  useEffect(() => {
    const interval = setInterval(() => {
      setBossTimers(currentTimers => currentTimers.filter(t => new Date(t.respawn_time) > new Date()))
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isAddingBase) {
          setIsAddingBase(false)
          setNewBaseCoords(null)
        }
        if (movingBaseId) setMovingBaseId(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAddingBase, movingBaseId])

  const broadcastToChat = async (message: string) => {
    try {
      await fetch('/api/palworld/announce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }) 
      })
    } catch (e) {
      console.error("Erreur d'envoi du message chat", e)
    }
  }

  const saveBase = async () => {
    if (!newBaseCoords) return
    if (!formData.isUnknown && !formData.name) return

    const baseType = formData.isUnknown ? 'unknown' : formData.type
    const playerName = formData.isUnknown ? 'Base Inconnue' : formData.name

    const { error } = await supabase.from('player_bases').insert([{
      player_name: playerName, 
      guild_name: formData.faction, 
      base_type: baseType, 
      location_x: newBaseCoords.x, 
      location_y: newBaseCoords.y
    }])
    
    if (!error) {
      setIsAddingBase(false); 
      setNewBaseCoords(null); 
      setFormData({ name: '', faction: '', type: 'main', isUnknown: false })
    }
  }

  const handleClaimBase = async () => {
    if (!selectedBase || !claimData.name) return
    
    const { error } = await supabase.from('player_bases').update({
      player_name: claimData.name,
      base_type: claimData.type
    }).eq('id', selectedBase.id)

    if (!error) {
      setSelectedBase(null)
      setClaimData({ name: '', type: 'main' })
    }
  }

  const handleDeleteBase = async (id: string, name: string) => {
    if (window.confirm(`Es-tu sûr de vouloir supprimer cette base ?`)) {
      await supabase.from('player_bases').delete().eq('id', id)
      setSelectedBase(null)
    }
  }

  const startMovingBase = () => {
    if (!selectedBase) return
    setMovingBaseId(selectedBase.id)
    setSelectedBase(null)
  }

  const handleDeleteTimer = async (id: string, bossName: string) => {
    if (window.confirm(`Es-tu sûr de vouloir supprimer le chronomètre pour ${bossName} ?`)) {
      await supabase.from('boss_timers').delete().eq('id', id)
      setBossTimers(prev => prev.filter(t => t.id !== id))
    }
  }

  const markBossDefeated = async () => {
    if (!bossFormName) return
    const bossName = bossFormName
    setIsReportingBoss(false)
    setBossFormName('')

    const now = new Date()
    const respawnDate = new Date(now.getTime() + BOSS_RESPAWN_TIME_MS)
    const heureParis = respawnDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })

    const bossKey = `manual-boss-${Date.now()}`
    const newId = crypto.randomUUID()

    const newTimer = { id: newId, boss_key: bossKey, name: bossName, respawn_time: respawnDate.toISOString(), notified_respawn: false }
    setBossTimers(prev => [...prev, newTimer])
    await supabase.from('boss_timers').upsert([newTimer])
    broadcastToChat(`>>>>> ${bossName} est vaincu. Respawn prévu à ${heureParis} <<<<<`)
  }

  const handleMouseMoveOnMap = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return
    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    
    const mapX = -topRatio * 256
    const mapY = leftRatio * 256
    
    const [worldX, worldY] = fromMapPosition([mapX, mapY])
    setMousePosition([worldX, worldY])
  }, [])

  // Recentrer la map sur un point spécifique
  const centerMapOn = useCallback((worldX: number, worldY: number) => {
    const [mapX, mapY] = toMapPosition([worldX, worldY])
    // Traduction de la coordonnée map (-256 à 256) en pixel par rapport au centre
    const targetX = -(mapY / 256) * 512 * scale
    const targetY = (mapX / 256) * 512 * scale
    setPan({ x: targetX, y: targetY })
  }, [scale])

  // Clic sur une base -> Centrer + Ouvrir fiche d'info
  const handleSelectBase = (base: any) => {
    setSelectedBase(base)
    centerMapOn(base.location_x, base.location_y)
  }

  useEffect(() => {
    if (!isDragging) return
    // Si l'utilisateur slide/déplace la carte, on ferme la fiche d'information ouverte
    if (selectedBase) setSelectedBase(null)

    const handleMouseMove = (event: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      const newX = start.panX + (event.clientX - start.x)
      const newY = start.panY + (event.clientY - start.y)
      if (mapPlaneRef.current) {
        mapPlaneRef.current.style.transform = `translate(-50%, -50%) translate(${newX}px, ${newY}px) scale(${scale})`
      }
    }
    const handleMouseUp = (event: MouseEvent) => { 
      if (dragStartRef.current) {
         setPan({
           x: dragStartRef.current.panX + (event.clientX - dragStartRef.current.x),
           y: dragStartRef.current.panY + (event.clientY - dragStartRef.current.y)
         })
      }
      dragStartRef.current = null
      setIsDragging(false) 
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [isDragging, scale, selectedBase])
  
  const handleMapClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) return 
    const planeRect = mapPlaneRef.current?.getBoundingClientRect()
    if (!planeRect) return
    const leftRatio = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1)
    const topRatio = clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1)
    const mapX = -topRatio * 256; const mapY = leftRatio * 256
    const [worldX, worldY] = fromMapPosition([mapX, mapY])
    
    if (isAddingBase) {
      setNewBaseCoords({ x: parseFloat(worldX), y: parseFloat(worldY) })
    } else if (movingBaseId) {
      await supabase.from('player_bases').update({
        location_x: parseFloat(worldX), 
        location_y: parseFloat(worldY)
      }).eq('id', movingBaseId)
      setMovingBaseId(null)
    }
  }, [isAddingBase, movingBaseId])

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      const newZoom = clamp(zoom + (event.deltaY < 0 ? 1 : -1), MIN_ZOOM, MAX_ZOOM)
      if (newZoom === zoom) return 
      const oldScale = 1 + zoom * 0.45
      const newScale = 1 + newZoom * 0.45
      const ratio = newScale / oldScale
      const rect = event.currentTarget.getBoundingClientRect()
      const mouseX = event.clientX - rect.left - rect.width / 2
      const mouseY = event.clientY - rect.top - rect.height / 2
      setPan({
        x: mouseX - (mouseX - pan.x) * ratio,
        y: mouseY - (mouseY - pan.y) * ratio
      })
      setZoom(newZoom)
    }, [zoom, pan])

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return 
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    setIsDragging(true)
  }, [pan.x, pan.y])

  const activeBossTimers = bossTimers.filter(t => new Date(t.respawn_time) > new Date())

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-4rem)] w-full overflow-hidden bg-background text-foreground relative font-sans select-none">
        
        {isAddingBase && !newBaseCoords && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-lg animate-pulse border border-blue-400">
            🖱️ Clic droit pour poser la base — (Echap pour annuler)
          </div>
        )}

        {movingBaseId && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-yellow-600 text-white px-6 py-2 rounded-full font-bold shadow-lg animate-pulse border border-yellow-400">
            🖱️ Clic droit pour placer la base — (Echap pour annuler)
          </div>
        )}

        <div className="relative flex-1 w-full h-full overflow-hidden bg-[#1e2329]">
          <div
            className={`relative h-full w-full overflow-hidden ${(isAddingBase && !newBaseCoords) || movingBaseId ? 'cursor-crosshair' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ overscrollBehavior: 'contain' }}
            onMouseDown={handleMouseDown} onMouseUp={handleMapClick} onWheel={handleWheel}
            onMouseMove={handleMouseMoveOnMap}
            onContextMenu={(e) => { if (isAddingBase || movingBaseId) e.preventDefault() }}
          >
            <div
              ref={mapPlaneRef} className="absolute left-1/2 top-1/2 will-change-transform transition-transform duration-500 ease-out"
              style={{ width: '1024px', height: '1024px', transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            >
              <img src={MAP_IMAGE_URL} alt="Carte du monde Palworld" className="block h-full w-full select-none" draggable={false} />

              {showFastTravels && fastTravelMarkers.map((marker) => (
                <div key={marker.key} className="absolute z-10 flex items-center justify-center" style={{ ...marker.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}>
                  <img src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="h-6 w-6 object-contain drop-shadow-md" draggable={false} />
                </div>
              ))}

              {showBases && basesWithPlayers.map((base) => {
                const position = toScreenPercent([base.location_x, base.location_y])
                const isUnknown = base.base_type === 'unknown'
                const isMain = base.base_type === 'main'
                const isActive = base.players && base.players.length > 0

                return (
                  <div key={base.id} className="absolute z-20 cursor-pointer group" style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} onClick={() => handleSelectBase(base)}>
                    
                    {isActive && (
                      <div className="absolute z-50 bottom-full mb-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/90 backdrop-blur-md px-2 py-1 rounded-md border border-green-500/50 shadow-2xl whitespace-nowrap pointer-events-none">
                        <div className="flex gap-[2px] items-end h-2">
                          <div className="w-[2px] h-full bg-green-400 animate-[bounce_1s_infinite]" />
                          <div className="w-[2px] h-[60%] bg-green-400 animate-[bounce_1s_infinite]" style={{ animationDelay: '150ms' }} />
                        </div>
                        <span className="text-[10px] font-bold text-green-400 uppercase">
                          {base.players.length} joueur{base.players.length > 1 ? 's' : ''}
                        </span>
                      </div>
                    )}

                    {isActive && !isUnknown && (
                      <div 
                        className="absolute z-0 top-0 left-1/2 -translate-x-1/2 rounded-full animate-pulse" 
                        style={{ 
                          width: isMain ? '50px' : '30px', 
                          height: isMain ? '50px' : '30px',
                          marginTop: isMain ? '-25px' : '-15px',
                          boxShadow: '0 0 25px 15px rgba(34, 197, 94, 0.5)',
                          backgroundColor: 'rgba(34, 197, 94, 0.2)'
                        }}
                      />
                    )}

                    <img 
                      src={isUnknown ? "/palworld-map/pin-base-inconnu.png" : "/palworld-map/pin-base.png"} 
                      alt="Base" 
                      className={`relative z-10 drop-shadow-xl transition-transform duration-300 group-hover:scale-125 object-contain -translate-y-1/2 ${isUnknown ? "h-10 w-10 opacity-90" : isMain ? "h-14 w-14" : "h-8 w-8"}`} 
                      draggable={false} 
                    />
                    
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 mt-2 pointer-events-none rounded-md bg-black/85 px-3 py-1.5 shadow-lg backdrop-blur-sm border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity z-30 flex flex-col items-center w-max">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        {isUnknown ? 'Base Inconnue' : base.player_name}
                        {!isUnknown && <span className="text-gray-400 text-[10px] font-normal">({isMain ? 'Principale' : 'Secondaire'})</span>}
                      </span>
                      
                      {isActive && (
                        <div className="mt-1 pt-1 border-t border-white/10 w-full flex flex-col items-center">
                          <span className="text-[10px] text-green-400 font-semibold mb-0.5">🟢 {base.players.length} Joueur(s) dans la base</span>
                          {base.players.map((p: any) => <span key={p.name} className="text-[9px] text-gray-300">{p.name}</span>)}
                        </div>
                      )}
                      <span className="mt-1 text-[9px] text-primary/80 font-normal italic">Clic pour voir la fiche</span>
                    </div>
                  </div>
                )
              })}

              {showBossTowers && bossTowerMarkers.map((point) => (
                <div key={point.key} className="absolute z-20 flex flex-col items-center justify-center cursor-pointer group" style={{ ...point.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}>
                  <img src="/palworld-map/boss_tower.webp" alt="Tour" className="h-10 w-10 select-none object-contain transition-transform group-hover:scale-110 drop-shadow-xl" draggable={false} />
                </div>
              ))}

              {showPlayers && clusteredPlayers.map((cluster) => { 
                const position = toScreenPercent([cluster.x, cluster.y])
                const isGroup = cluster.players.length > 1
                
                return (
                  <div key={cluster.id} 
                      className="absolute z-30 flex flex-col items-center group pointer-events-auto" 
                      style={{ 
                        ...position, 
                        transform: `translate(-50%, -50%) scale(${1 / scale})`,
                        transition: 'left 5s linear, top 5s linear' 
                      }}>
                    <div className="absolute bottom-full mb-1 pointer-events-none z-10 flex flex-col items-center justify-center rounded-md border border-primary/30 bg-background/80 px-2 py-1 shadow-lg backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
                      {isGroup ? (
                        <>
                          <span className="text-[10px] font-bold text-primary mb-0.5">{cluster.players.length} Joueurs ensemble</span>
                          {cluster.players.map(p => <span key={p.name} className="whitespace-nowrap text-[11px] font-bold text-foreground leading-tight">{p.name}</span>)}
                        </>
                      ) : (
                        <span className="whitespace-nowrap text-[11px] font-bold text-foreground drop-shadow-sm leading-tight">{cluster.players[0].name}</span>
                      )}
                    </div>
                    <img src="/palworld-map/pin-joueur.png" alt="Joueur" className={`relative z-0 ${isGroup ? 'h-12 w-12' : 'h-10 w-10'} select-none object-contain drop-shadow-md transition-transform duration-300 group-hover:scale-125 -translate-y-1/2`} draggable={false} />
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Boutons de zoom */}
        <div className="absolute bottom-6 left-6 lg:left-[350px] z-40 flex flex-col gap-2 transition-all duration-300">
          <Card className="bg-background/70 backdrop-blur-xl border-white/10 shadow-2xl overflow-hidden flex flex-col pointer-events-auto">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}><ZoomInIcon className="h-5 w-5" /></Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}><ZoomOutIcon className="h-5 w-5" /></Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => { setZoom(2); setPan({x:0, y:0}) }}><CrosshairIcon className="h-4 w-4" /></Button>
          </Card>
        </div>

        {/* Panneau latéral gauche (Filtres) */}
        <div className="absolute left-6 top-6 z-40 flex hidden w-[300px] flex-col gap-6 lg:flex max-h-[calc(100%-3rem)] overflow-y-auto pointer-events-none custom-scrollbar">
          <Card className="pointer-events-auto border-white/10 bg-background/60 p-5 text-foreground shadow-2xl backdrop-blur-xl rounded-2xl">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
              <MapPinIcon className="h-5 w-5 text-primary" /> Filtres de Carte
            </h3>
            <div className="space-y-2 rounded-xl border border-white/5 bg-black/20 p-4 mb-4">
              <ControlRow label="Bases des joueurs" checked={showBases} onCheckedChange={setShowBases} />
              <ControlRow label="Tours" checked={showBossTowers} onCheckedChange={setShowBossTowers} />
              <ControlRow label="Points de téléportation" checked={showFastTravels} onCheckedChange={setShowFastTravels} />
              <ControlRow label="Afficher les joueurs" checked={showPlayers} onCheckedChange={setShowPlayers} />
            </div>

            <div className="space-y-3">
              <Button onClick={() => setIsAddingBase(true)} disabled={isAddingBase || movingBaseId !== null} className="w-full gap-2 bg-primary/90 hover:bg-primary shadow-lg shadow-primary/20 transition-all rounded-xl disabled:opacity-50">
                <MapPinIcon className="h-4 w-4" /> {isAddingBase ? 'Placement...' : 'Signaler une base'}
              </Button>
              <Button onClick={() => setIsReportingBoss(true)} className="w-full gap-2 bg-red-600/90 hover:bg-red-600 shadow-lg shadow-red-600/20 transition-all rounded-xl">
                <SwordsIcon className="h-4 w-4" /> Signaler un Boss vaincu
              </Button>
            </div>
          </Card>
          
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
                  <div key={timer.id} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 text-sm group hover:bg-red-500/10 transition-colors">
                    <span className="font-semibold text-foreground/90 truncate mr-2">{timer.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-red-400 font-mono text-xs bg-red-500/10 px-2 py-1 rounded-md border border-red-500/20">
                        <LiveCountdown targetDate={timer.respawn_time} />
                      </span>
                      <button onClick={() => handleDeleteTimer(timer.id, timer.name)} className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-300 transition-opacity">
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* SIDEBAR : FICHE D'INFORMATION DE LA BASE SÉLECTIONNÉE (Style carte latérale sans flou) */}
        {selectedBase && (
          <div className="absolute top-6 right-6 bottom-6 w-[340px] z-50 pointer-events-none flex flex-col justify-start animate-in slide-in-from-right duration-300">
            <Card className="pointer-events-auto w-full max-h-full overflow-y-auto p-6 shadow-2xl border-white/10 bg-background/85 backdrop-blur-xl rounded-2xl relative flex flex-col custom-scrollbar">
              <button onClick={() => setSelectedBase(null)} className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors bg-white/5 p-1 rounded-full">
                <XIcon className="h-4 w-4" />
              </button>
              
              <div className="flex items-center gap-3 mb-6 pr-6">
                <div className="h-11 w-11 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <MapPinIcon className="h-5 w-5 text-primary" />
                </div>
                <div className="truncate">
                  <h4 className="text-lg font-bold truncate">{selectedBase.base_type === 'unknown' ? 'Base Inconnue' : selectedBase.player_name}</h4>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    {selectedBase.base_type === 'unknown' ? '📍 Emplacement libre' : selectedBase.base_type === 'main' ? <><StarIcon className="h-3 w-3 text-yellow-500 fill-yellow-500" /> Base Principale</> : <><HomeIcon className="h-3 w-3 text-blue-400" /> Base Secondaire</>}
                  </p>
                </div>
              </div>

              <div className="text-[11px] font-mono text-muted-foreground bg-black/30 p-2.5 rounded-xl border border-white/5 mb-5 flex justify-around">
                <span>X: {selectedBase.location_x.toFixed(1)}</span>
                <span>Y: {selectedBase.location_y.toFixed(1)}</span>
              </div>

              {selectedBase.base_type === 'unknown' ? (
                <div className="space-y-4 mb-6 p-4 rounded-xl border border-primary/30 bg-primary/5">
                  <h5 className="text-xs font-bold text-primary uppercase tracking-wider">Revendiquer cette zone</h5>
                  <input type="text" className="flex h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm focus:ring-2 focus:ring-primary outline-none text-white" value={claimData.name} onChange={e => setClaimData({...claimData, name: e.target.value})} placeholder="Entre ton pseudo..." />
                  <select className="flex h-10 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm focus:ring-2 focus:ring-primary outline-none text-white" value={claimData.type} onChange={e => setClaimData({...claimData, type: e.target.value})}>
                    <option value="main">⭐ Base Principale</option>
                    <option value="sub_1">🏠 Base Secondaire</option>
                  </select>
                  <Button className="w-full rounded-xl shadow-lg shadow-primary/20" onClick={handleClaimBase} disabled={!claimData.name}>Revendiquer</Button>
                </div>
              ) : (
                <div className="space-y-4 mb-6 flex-1">
                  {selectedBase.players && selectedBase.players.length > 0 && (
                    <div className="p-3 rounded-xl border border-green-500/20 bg-green-500/5">
                      <span className="text-xs font-bold text-green-400 block mb-1">🟢 Actuellement sur place :</span>
                      <div className="flex flex-wrap gap-1">
                        {selectedBase.players.map((p: any) => (
                          <Badge key={p.name} variant="secondary" className="bg-white/5 text-white text-[10px]">{p.name}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="p-4 rounded-xl border border-white/5 bg-black/20 text-center text-xs text-muted-foreground italic">
                    📅 Historique des visites<br/>
                    <span className="text-[10px] text-primary/60">(Prochainement)</span>
                  </div>
                  <div className="p-4 rounded-xl border border-white/5 bg-black/20 text-center text-xs text-muted-foreground italic">
                    ⭐ Système de notes & avis<br/>
                    <span className="text-[10px] text-primary/60">(Prochainement)</span>
                  </div>
                </div>
              )}

              <div className="flex gap-3 justify-between pt-4 border-t border-white/10 mt-auto">
                <Button variant="ghost" className="rounded-xl hover:bg-red-500/10 text-red-400 hover:text-red-400 gap-2 flex-1 text-xs" onClick={() => handleDeleteBase(selectedBase.id, selectedBase.player_name)}>
                  <TrashIcon className="h-3.5 w-3.5" /> Supprimer
                </Button>
                <Button variant="secondary" className="rounded-xl gap-2 flex-1 bg-white/5 hover:bg-white/10 text-xs text-foreground" onClick={startMovingBase}>
                  <MoveIcon className="h-3.5 w-3.5" /> Déplacer
                </Button>
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* MODALE DE CRÉATION DE BASE (Corrigée pour soumettre sans nom si Unknown) */}
      {newBaseCoords && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-white/10 bg-background/90 backdrop-blur-xl rounded-2xl">
            <h3 className="text-xl font-bold mb-4">Nouvelle Base</h3>
            <div className="space-y-4">
              
              <label className="flex items-center gap-3 p-3 border border-white/10 rounded-xl bg-black/20 cursor-pointer hover:bg-white/5 transition-colors">
                <Switch checked={formData.isUnknown} onCheckedChange={(c) => setFormData({...formData, isUnknown: c})} />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">Base non revendiquée</span>
                  <span className="text-[10px] text-muted-foreground">Coche s'il s'agit d'un emplacement libre trouvé</span>
                </div>
              </label>

              {!formData.isUnknown && (
                <>
                  <input type="text" className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="Nom du joueur / Guilde..." autoFocus />
                  <select className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                    <option value="main">⭐ Base Principale</option>
                    <option value="sub_1">🏠 Base Secondaire</option>
                  </select>
                </>
              )}
              
              <div className="flex gap-3 justify-end pt-4 border-t border-white/10">
                <Button variant="ghost" className="rounded-xl hover:bg-white/5" onClick={() => { setIsAddingBase(false); setNewBaseCoords(null); setFormData({...formData, isUnknown: false}) }}>Annuler</Button>
                <Button className="rounded-xl" onClick={saveBase} disabled={!formData.isUnknown && !formData.name}>Déployer</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Formulaire Boss */}
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
                onKeyDown={(e) => { if (e.key === 'Enter') markBossDefeated() }}
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