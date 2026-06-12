'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPinIcon, ZoomInIcon, ZoomOutIcon, CrosshairIcon, SwordsIcon, BellIcon, TrashIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getPlayerKey } from '@/lib/palworld'
import { useServer } from '@/lib/server-context'
import points from '@/lib/map-points.json'
import { supabase } from '@/lib/supabase'


const BASE_RADIUS = 10000; 
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
  
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'main', color: '#3b82f6' })

  const [isReportingBoss, setIsReportingBoss] = useState(false)
  const [bossFormName, setBossFormName] = useState('')

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(() => players.filter((player) => player.location_x !== 0 || player.location_y !== 0), [players])

    
  const { basesWithPlayers, clusteredPlayers } = useMemo(() => {
      // On prépare nos bases pour accueillir des joueurs
      const basesData = bases.map(b => ({ ...b, players: [] as typeof mappablePlayers }))
      const remainingPlayers: typeof mappablePlayers = []

      // 1. Assigner les joueurs à la base la plus proche
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

      // 2. Grouper les joueurs restants en "escouades" s'ils sont proches
      const clusters: { id: string, x: number, y: number, players: typeof mappablePlayers }[] = []
      
      remainingPlayers.forEach(player => {
        let addedToCluster = false
        for (let cluster of clusters) {
          const dist = Math.hypot(player.location_x - cluster.x, player.location_y - cluster.y)
          if (dist < PLAYER_CLUSTER_RADIUS) {
            cluster.players.push(player)
            // On déplace légèrement le centre du groupe pour moyenner la position
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
      if (e.key === 'Escape' && isAddingBase) {
        setIsAddingBase(false)
        setNewBaseCoords(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAddingBase])

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
    if (!newBaseCoords || !formData.name) return
    const { error } = await supabase.from('player_bases').insert([{
      player_name: formData.name, guild_name: formData.faction, base_type: formData.type, 
      location_x: newBaseCoords.x, location_y: newBaseCoords.y, color_hex: formData.color
    }])
    if (!error) {
      setIsAddingBase(false); setNewBaseCoords(null); setFormData({ name: '', faction: '', type: 'main', color: '#3b82f6' })
    }
  }

  const handleDeleteBase = async (id: string, name: string) => {
    if (window.confirm(`Es-tu sûr de vouloir supprimer la base de ${name} ?`)) {
      await supabase.from('player_bases').delete().eq('id', id)
    }
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

  // --- NOUVEAU : Suivi de la souris pour le calibrage ---
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

  useEffect(() => {
    if (!isDragging) return
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
  }, [isDragging, scale])
  
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
      
      // 1. Calcul du nouveau zoom basé sur le zoom actuel (plus de fonction imbriquée)
      const newZoom = clamp(zoom + (event.deltaY < 0 ? 1 : -1), MIN_ZOOM, MAX_ZOOM)
      if (newZoom === zoom) return // On ne fait rien si on est déjà au max/min

      // 2. Calcul du ratio de changement d'échelle
      const oldScale = 1 + zoom * 0.45
      const newScale = 1 + newZoom * 0.45
      const ratio = newScale / oldScale

      // 3. Position de la souris par rapport au centre du conteneur
      const rect = event.currentTarget.getBoundingClientRect()
      const mouseX = event.clientX - rect.left - rect.width / 2
      const mouseY = event.clientY - rect.top - rect.height / 2

      // 4. Calcul et mise à jour du nouveau Pan
      setPan({
        x: mouseX - (mouseX - pan.x) * ratio,
        y: mouseY - (mouseY - pan.y) * ratio
      })

      // 5. Mise à jour du Zoom
      setZoom(newZoom)
      
    }, [zoom, pan]) // Important : on ajoute zoom et pan dans les dépendances

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
        
        {isAddingBase && !newBaseCoords && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-lg animate-pulse border border-blue-400">
            🖱️ Clic droit pour poser la base — (Echap pour annuler)
          </div>
        )}

        <div className="relative flex-1 w-full h-full overflow-hidden bg-[#1e2329]">
          <div
            className={`relative h-full w-full overflow-hidden ${isAddingBase && !newBaseCoords ? 'cursor-crosshair' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            style={{ overscrollBehavior: 'contain' }}
            onMouseDown={handleMouseDown} onMouseUp={handleMapClick} onWheel={handleWheel}
            onMouseMove={handleMouseMoveOnMap} /* <-- Ajout du suivi de la souris ici */
            onContextMenu={(e) => { if (isAddingBase) e.preventDefault() }}
          >
            <div
              ref={mapPlaneRef} className="absolute left-1/2 top-1/2 will-change-transform"
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
                const isMain = base.base_type === 'main'
                return (
                  <div key={base.id} className="absolute z-20 cursor-pointer group" style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} onDoubleClick={() => handleDeleteBase(base.id, base.player_name)}>
                    
                  {/* L'indicateur Hologramme Ultra-Compact */}
                  {base.players && base.players.length > 0 && (
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/80 backdrop-blur-md px-1.5 py-0.5 rounded-[3px] border-b border-green-400 shadow-md z-10 pointer-events-none transition-transform group-hover:-translate-y-1">
                      {/* Mini égaliseur réduit */}
                      <div className="flex gap-[1px] items-end h-1.5">
                        <div className="w-[1.5px] h-full bg-green-400 animate-[bounce_1s_infinite]" style={{ animationDelay: '0ms' }} />
                        <div className="w-[1.5px] h-[60%] bg-green-400 animate-[bounce_1s_infinite]" style={{ animationDelay: '150ms' }} />
                        <div className="w-[1.5px] h-[80%] bg-green-400 animate-[bounce_1s_infinite]" style={{ animationDelay: '300ms' }} />
                      </div>
                      <span className="text-[7px] font-bold text-green-400 tracking-wider uppercase leading-none">
                        {base.players.length}
                      </span>
                    </div>
                  )}

                    <img src="/palworld-map/pin-base.png" alt="Base" className={`drop-shadow-xl transition-transform duration-300 group-hover:scale-125 object-contain -translate-y-1/2 ${isMain ? "h-14 w-14" : "h-8 w-8"}`} draggable={false} />

                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 mt-2 pointer-events-none rounded-md bg-black/85 px-3 py-1.5 shadow-lg backdrop-blur-sm border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity z-30 flex flex-col items-center w-max">
                      <span className="text-xs font-bold text-white flex items-center gap-1.5">
                        {base.player_name}
                        <span className="text-gray-400 text-[10px] font-normal">({isMain ? 'Principale' : 'Secondaire'})</span>
                      </span>
                      
                      {base.players && base.players.length > 0 && (
                        <div className="mt-1 pt-1 border-t border-white/10 w-full flex flex-col items-center">
                          <span className="text-[10px] text-green-400 font-semibold mb-0.5">🟢 {base.players.length} Joueur(s) dans la base</span>
                          {base.players.map((p: any) => <span key={p.name} className="text-[9px] text-gray-300">{p.name}</span>)}
                        </div>
                      )}
                      
                      <span className="mt-1.5 text-[9px] text-red-400 font-normal italic">(Double-clic pour suppr.)</span>
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
                    
                    {/* NOUVEAU : Le nom grossit en même temps grâce au group-hover:scale-110 */}
                    <div className="absolute bottom-full mb-1 pointer-events-none z-10 flex flex-col items-center justify-center rounded-md border border-primary/30 bg-background/80 px-2 py-1 shadow-lg backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
                      {isGroup ? (
                        <>
                          {/* S'ils sont plusieurs, on affiche le nombre et la liste */}
                          <span className="text-[10px] font-bold text-primary mb-0.5">{cluster.players.length} Joueurs ensemble</span>
                          {cluster.players.map(p => <span key={p.name} className="whitespace-nowrap text-[11px] font-bold text-foreground leading-tight">{p.name}</span>)}
                        </>
                      ) : (
                        /* S'il est seul, affichage classique */
                        <span className="whitespace-nowrap text-[11px] font-bold text-foreground drop-shadow-sm leading-tight">{cluster.players[0].name}</span>
                      )}
                    </div>
                    
                    {/* Si c'est un groupe, l'icône est un peu plus grande */}
                    <img src="/palworld-map/pin-joueur.png" alt="Joueur" className={`relative z-0 ${isGroup ? 'h-12 w-12' : 'h-10 w-10'} select-none object-contain drop-shadow-md transition-transform duration-300 group-hover:scale-125 -translate-y-1/2`} draggable={false} />
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="absolute bottom-6 right-6 z-50 flex flex-col gap-2">
          <Card className="bg-background/70 backdrop-blur-xl border-white/10 shadow-2xl overflow-hidden flex flex-col">
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}><ZoomInIcon className="h-5 w-5" /></Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => setZoom(z => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}><ZoomOutIcon className="h-5 w-5" /></Button>
            <div className="h-[1px] w-full bg-border/50" />
            <Button variant="ghost" size="icon" className="h-10 w-10 rounded-none hover:bg-white/10" onClick={() => { setZoom(2); setPan({x:0, y:0}) }}><CrosshairIcon className="h-4 w-4" /></Button>
          </Card>
        </div>

        <div className="absolute left-6 top-6 z-50 flex hidden w-[320px] flex-col gap-6 lg:flex max-h-[calc(100%-3rem)] overflow-y-auto pointer-events-none custom-scrollbar">
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
              <Button onClick={() => setIsAddingBase(true)} disabled={isAddingBase} className="w-full gap-2 bg-primary/90 hover:bg-primary shadow-lg shadow-primary/20 transition-all rounded-xl disabled:opacity-50">
                <MapPinIcon className="h-4 w-4" /> {isAddingBase ? 'Placement en cours...' : 'Signaler ma base'}
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
      </div>

      {newBaseCoords && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4">
          <Card className="w-full max-w-sm p-6 shadow-2xl border-white/10 bg-background/90 backdrop-blur-xl rounded-2xl">
            <h3 className="text-xl font-bold mb-4">Nouvelle Base</h3>
            <div className="space-y-4">
              <input type="text" className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="Nom du joueur / Guilde..." autoFocus />
              <select className="flex h-11 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-sm focus:ring-2 focus:ring-primary outline-none" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                <option value="main">⭐ Base Principale</option>
                <option value="sub_1">🏠 Base Secondaire</option>
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