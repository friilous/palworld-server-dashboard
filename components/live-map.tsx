'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapPinIcon, ZoomInIcon, ZoomOutIcon, CrosshairIcon, SwordsIcon, BellIcon, TrashIcon, XIcon, MoveIcon, StarIcon, MessageSquareIcon, ClockIcon, UserIcon, LogOutIcon } from 'lucide-react'
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
  
  const [isAddingBase, setIsAddingBase] = useState(false)
  const [newBaseCoords, setNewBaseCoords] = useState<{ x: number, y: number } | null>(null)
  const [formData, setFormData] = useState({ name: '', faction: '', type: 'main', isUnknown: false })
  
  const [selectedBase, setSelectedBase] = useState<any | null>(null)
  const [claimData, setClaimData] = useState({ name: '', type: 'main' })
  const [movingBaseId, setMovingBaseId] = useState<string | null>(null)

  const [isReportingBoss, setIsReportingBoss] = useState(false)
  const [bossFormName, setBossFormName] = useState('')

  // NOUVEAUX ETATS POUR LE SYSTEME DE COMPTE ET LA FICHE BASE
  const [currentUser, setCurrentUser] = useState<{ name: string, isGuest: boolean } | null>(null)
  const [loginInputName, setLoginInputName] = useState('')
  const [activeTab, setActiveTab] = useState<'info' | 'reviews' | 'history'>('info')
  const [baseDetails, setBaseDetails] = useState<{ reviews: any[], ratings: any[], visits: any[] }>({ reviews: [], ratings: [], visits: [] })
  const [newReview, setNewReview] = useState('')
  
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)
  const recordedVisitsRef = useRef<Record<string, number>>({})

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(() => players.filter((player) => player.location_x !== 0 || player.location_y !== 0), [players])

  // CHARGEMENT DU COMPTE AU LANCEMENT
  useEffect(() => {
    const savedUser = localStorage.getItem('palworld_livemap_user')
    if (savedUser) {
      setCurrentUser(JSON.parse(savedUser))
    }
  }, [])

  const handleLogin = (isGuest: boolean) => {
    if (!isGuest && !loginInputName.trim()) return
    const user = { name: isGuest ? 'Invité' : loginInputName.trim(), isGuest }
    setCurrentUser(user)
    localStorage.setItem('palworld_livemap_user', JSON.stringify(user))
  }

  const handleLogout = () => {
    setCurrentUser(null)
    localStorage.removeItem('palworld_livemap_user')
  }

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

  // ENREGISTREMENT AUTOMATIQUE DES VISITES
  useEffect(() => {
    if (!currentUser || currentUser.isGuest) return;
    
    basesWithPlayers.forEach(base => {
      const isMeInBase = base.players.some((p: any) => p.name.toLowerCase() === currentUser.name.toLowerCase());
      if (isMeInBase) {
         const visitKey = `${base.id}-${currentUser.name}`;
         const lastVisit = recordedVisitsRef.current[visitKey] || 0;
         // Cooldown de 30 minutes avant de re-sauvegarder une visite
         if (Date.now() - lastVisit > 30 * 60 * 1000) {
             recordedVisitsRef.current[visitKey] = Date.now();
             supabase.from('base_visits').insert([{ base_id: base.id, player_name: currentUser.name }]).then();
         }
      }
    });
  }, [basesWithPlayers, currentUser])

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

  // FETCH DES DETAILS DE LA BASE QUAND ON LA CLIQUE
  const fetchBaseDetails = async (baseId: string) => {
    const [reviews, ratings, visits] = await Promise.all([
      supabase.from('base_reviews').select('*').eq('base_id', baseId).order('created_at', { ascending: false }),
      supabase.from('base_ratings').select('*').eq('base_id', baseId),
      supabase.from('base_visits').select('*').eq('base_id', baseId).order('visited_at', { ascending: false }).limit(20)
    ])
    setBaseDetails({
      reviews: reviews.data || [],
      ratings: ratings.data || [],
      visits: visits.data || []
    })
  }

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
        if (isAddingBase) { setIsAddingBase(false); setNewBaseCoords(null) }
        if (movingBaseId) { setMovingBaseId(null) }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAddingBase, movingBaseId])

  const saveBase = async () => {
    if (!newBaseCoords) return
    if (!formData.isUnknown && !formData.name) return

    const baseType = formData.isUnknown ? 'main' : formData.type
    const playerName = formData.isUnknown ? 'Base Inconnue' : formData.name
    const guildName = formData.isUnknown ? null : formData.faction

    const { error } = await supabase.from('player_bases').insert([{
      player_name: playerName, 
      guild_name: guildName,
      base_type: baseType, 
      location_x: newBaseCoords.x, 
      location_y: newBaseCoords.y,
      created_by: currentUser?.name // Sauvegarde du créateur
    }])
    
    if (error) {
      alert("Erreur lors de l'ajout de la base : " + error.message)
      return
    }

    setIsAddingBase(false); setNewBaseCoords(null); 
    setFormData({ name: '', faction: '', type: 'main', isUnknown: false })
  }

  const handleClaimBase = async () => {
    if (!selectedBase || !claimData.name) return
    const { error } = await supabase.from('player_bases').update({ player_name: claimData.name, base_type: claimData.type }).eq('id', selectedBase.id)
    if (!error) { setSelectedBase(null); setClaimData({ name: '', type: 'main' }) }
  }

  const handleDeleteBase = async (id: string, name: string) => {
    if (window.confirm(`Es-tu sûr de vouloir supprimer la base de ${name} ?`)) {
      await supabase.from('player_bases').delete().eq('id', id)
      setSelectedBase(null)
    }
  }

  const startMovingBase = () => {
    if (!selectedBase) return
    setMovingBaseId(selectedBase.id)
    setSelectedBase(null)
  }

  // SYSTEME DE VOTE
  const handleRate = async (rating: number) => {
    if (!currentUser || currentUser.isGuest || !selectedBase) return
    await supabase.from('base_ratings').upsert({ base_id: selectedBase.id, player_name: currentUser.name, rating }, { onConflict: 'base_id, player_name' })
    fetchBaseDetails(selectedBase.id) // Refresh
  }

  // SYSTEME DE COMMENTAIRE
  const handlePostReview = async () => {
    if (!currentUser || currentUser.isGuest || !selectedBase || !newReview.trim()) return
    await supabase.from('base_reviews').insert([{ base_id: selectedBase.id, player_name: currentUser.name, content: newReview.trim() }])
    setNewReview('')
    fetchBaseDetails(selectedBase.id) // Refresh
  }

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
      await supabase.from('player_bases').update({ location_x: parseFloat(worldX), location_y: parseFloat(worldY) }).eq('id', movingBaseId)
      setMovingBaseId(null)
    }
  }, [isAddingBase, movingBaseId])

  const handleBaseClick = (e: React.MouseEvent, base: any) => {
    e.stopPropagation() 
    setSelectedBase(base)
    setActiveTab('info') // Reset tab
    fetchBaseDetails(base.id)

    const [mapX, mapY] = toMapPosition([base.location_x, base.location_y])
    const targetPanX = (0.5 - mapY / 256) * 1024
    const targetPanY = (0.5 - -mapX / 256) * 1024
    setPan({ x: targetPanX, y: targetPanY })
  }

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const newZoom = clamp(zoom + (event.deltaY < 0 ? 1 : -1), MIN_ZOOM, MAX_ZOOM)
    if (newZoom === zoom) return 
    const oldScale = 1 + zoom * 0.45; const newScale = 1 + newZoom * 0.45; const ratio = newScale / oldScale
    const rect = event.currentTarget.getBoundingClientRect()
    const mouseX = event.clientX - rect.left - rect.width / 2; const mouseY = event.clientY - rect.top - rect.height / 2
    setPan({ x: mouseX - (mouseX - pan.x) * ratio, y: mouseY - (mouseY - pan.y) * ratio })
    setZoom(newZoom)
  }, [zoom, pan])

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return 
    event.preventDefault() 
    if (selectedBase) setSelectedBase(null)
    dragStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    setIsDragging(true)
  }, [pan.x, pan.y, selectedBase])

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      const start = dragStartRef.current; if (!start) return
      if (mapPlaneRef.current) mapPlaneRef.current.style.transform = `translate(-50%, -50%) translate(${start.panX + (e.clientX - start.x)}px, ${start.panY + (e.clientY - start.y)}px) scale(${scale})`
    }
    const handleMouseUp = (e: MouseEvent) => { 
      if (dragStartRef.current) setPan({ x: dragStartRef.current.panX + (e.clientX - dragStartRef.current.x), y: dragStartRef.current.panY + (e.clientY - dragStartRef.current.y) })
      dragStartRef.current = null; setIsDragging(false) 
    }
    window.addEventListener('mousemove', handleMouseMove); window.addEventListener('mouseup', handleMouseUp)
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp) }
  }, [isDragging, scale])

  const handleMouseMoveOnMap = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const planeRect = mapPlaneRef.current?.getBoundingClientRect(); if (!planeRect) return
    const mapX = -clamp((event.clientY - planeRect.top) / planeRect.height, 0, 1) * 256
    const mapY = clamp((event.clientX - planeRect.left) / planeRect.width, 0, 1) * 256
    setMousePosition(fromMapPosition([mapX, mapY]))
  }, [])

  // -- RENDU DU MODAL DE CONNEXION INITIAL --
  if (!currentUser) {
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/90 backdrop-blur-xl">
        <Card className="w-full max-w-md p-8 border-white/10 bg-background/80 flex flex-col items-center gap-6 text-center">
          <div className="h-16 w-16 bg-primary/20 rounded-full flex items-center justify-center text-primary mb-2">
            <UserIcon className="h-8 w-8" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Qui es-tu ?</h2>
            <p className="text-sm text-muted-foreground">Identifie-toi pour pouvoir voter et laisser des avis sur les bases de la map.</p>
          </div>
          
          <div className="w-full space-y-4">
            <input 
              type="text" 
              placeholder="Ton pseudo en jeu..." 
              className="flex h-12 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-center text-lg focus:ring-2 focus:ring-primary outline-none"
              value={loginInputName}
              onChange={(e) => setLoginInputName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin(false)}
              autoFocus
            />
            <Button className="w-full h-12 text-md rounded-xl shadow-lg shadow-primary/20" onClick={() => handleLogin(false)} disabled={!loginInputName.trim()}>
              Se connecter
            </Button>
            <div className="flex items-center gap-4 my-2">
              <div className="h-[1px] flex-1 bg-white/10" />
              <span className="text-xs text-muted-foreground uppercase tracking-widest">Ou</span>
              <div className="h-[1px] flex-1 bg-white/10" />
            </div>
            <Button variant="secondary" className="w-full h-12 text-md rounded-xl bg-white/5 hover:bg-white/10" onClick={() => handleLogin(true)}>
              Continuer en Invité
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const activeBossTimers = bossTimers.filter(t => new Date(t.respawn_time) > new Date())

  return (
    <>
      {/* BADGE UTILISATEUR CONNECTÉ EN BAS AU MILIEU */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-black/80 backdrop-blur-xl border border-white/10 px-4 py-2 rounded-full shadow-2xl">
        <div className="flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">{currentUser.name}</span>
          {currentUser.isGuest && <Badge variant="secondary" className="text-[10px] h-5 bg-white/10">Lecture seule</Badge>}
        </div>
        <div className="w-[1px] h-4 bg-white/20 mx-1" />
        <button onClick={handleLogout} className="text-muted-foreground hover:text-red-400 transition-colors" title="Changer de compte">
          <LogOutIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col h-[calc(100vh-4rem)] w-full overflow-hidden bg-background text-foreground relative font-sans">
        
        {isAddingBase && !newBaseCoords && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-6 py-2 rounded-full font-bold shadow-lg animate-pulse border border-blue-400">
            🖱️ Clic droit pour poser la base — (Echap pour annuler)
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
              ref={mapPlaneRef} className="absolute left-1/2 top-1/2 will-change-transform transition-transform duration-300 ease-out"
              style={{ width: '1024px', height: '1024px', transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            >
              <img src={MAP_IMAGE_URL} alt="Carte du monde Palworld" className="block h-full w-full select-none" draggable={false} />

              {/* POINTS FIXES ET JOUEURS (Gardés intacts pour abréger l'exemple) */}
              {showFastTravels && fastTravelMarkers.map((m) => (<div key={m.key} className="absolute z-10" style={{ ...m.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}><img src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="h-6 w-6 drop-shadow-md" draggable={false} /></div>))}

              {showBases && basesWithPlayers.map((base) => {
                const position = toScreenPercent([base.location_x, base.location_y])
                const isUnknown = base.player_name === 'Base Inconnue'
                const isMain = base.base_type === 'main'
                const isSelected = selectedBase?.id === base.id
                
                // Calcul moyenne étoile pour la vignette
                const myRating = baseDetails.ratings.find(r => r.player_name === currentUser.name)?.rating || 0;
                const avgRating = baseDetails.ratings.length > 0 ? (baseDetails.ratings.reduce((a,b)=>a+b.rating,0) / baseDetails.ratings.length).toFixed(1) : 0;

                return (
                  <div key={base.id} className={`absolute cursor-pointer group ${isSelected ? 'z-[60]' : 'z-20'}`} style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} onClick={(e) => handleBaseClick(e, base)}>
                    
                    <img src={isUnknown ? "/palworld-map/pin-base-inconnu.png" : "/palworld-map/pin-base.png"} alt="Base" className={`relative z-10 drop-shadow-xl transition-transform duration-300 group-hover:scale-125 object-contain -translate-y-1/2 ${isUnknown ? "h-10 w-10 opacity-80" : isMain ? "h-14 w-14" : "h-8 w-8"}`} draggable={false} />
                    
                    {!isSelected && (
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 mt-2 pointer-events-none rounded-md bg-black/85 px-3 py-1.5 shadow-lg backdrop-blur-sm border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity z-30 flex flex-col items-center w-max">
                        <span className="text-xs font-bold text-white flex items-center gap-1.5">{isUnknown ? 'Base Inconnue' : base.player_name}</span>
                      </div>
                    )}

                    {/* FICHE D'INFORMATION AUGMENTEE */}
                    {isSelected && (
                      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 cursor-default animate-in fade-in zoom-in-95 duration-200" onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                        <Card className="w-[320px] shadow-2xl shadow-black/50 border-white/10 bg-background/95 backdrop-blur-xl rounded-xl relative overflow-hidden flex flex-col">
                          
                          {/* Header */}
                          <div className="p-4 pb-3 border-b border-white/10 bg-black/20">
                            <button onClick={() => setSelectedBase(null)} className="absolute top-3 right-3 text-gray-400 hover:text-white transition-colors z-10"><XIcon className="h-4 w-4" /></button>
                            <div className="flex items-center gap-3">
                              <div className="h-10 w-10 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                                <MapPinIcon className="h-5 w-5 text-primary" />
                              </div>
                              <div className="min-w-0 pr-6">
                                <h3 className="text-base font-bold truncate">{isUnknown ? 'Base Inconnue' : base.player_name}</h3>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <span>{isUnknown ? 'Non revendiquée' : base.base_type === 'main' ? 'Principale' : 'Secondaire'}</span>
                                  {!isUnknown && Number(avgRating) > 0 && <span className="flex items-center text-yellow-400"><StarIcon className="h-3 w-3 fill-yellow-400 mr-0.5"/> {avgRating}</span>}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Tab Navigation */}
                          <div className="flex px-2 pt-2 gap-1 border-b border-white/5">
                            <button onClick={()=>setActiveTab('info')} className={`text-[11px] font-bold px-3 py-1.5 rounded-t-lg transition-colors ${activeTab === 'info' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}>Infos</button>
                            <button onClick={()=>setActiveTab('reviews')} className={`text-[11px] font-bold px-3 py-1.5 rounded-t-lg transition-colors flex items-center gap-1 ${activeTab === 'reviews' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}><MessageSquareIcon className="h-3 w-3"/> Avis ({baseDetails.reviews.length})</button>
                            <button onClick={()=>setActiveTab('history')} className={`text-[11px] font-bold px-3 py-1.5 rounded-t-lg transition-colors flex items-center gap-1 ${activeTab === 'history' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}><ClockIcon className="h-3 w-3"/> Visites</button>
                          </div>

                          {/* Tab Content */}
                          <div className="p-4 bg-black/10 min-h-[140px] max-h-[220px] overflow-y-auto custom-scrollbar">
                            
                            {activeTab === 'info' && (
                              <div className="space-y-4">
                                {isUnknown ? (
                                  <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
                                    <h4 className="text-xs font-bold text-primary">Revendiquer la base</h4>
                                    <input type="text" className="flex h-9 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-xs focus:ring-2 focus:ring-primary outline-none" value={claimData.name} onChange={e => setClaimData({...claimData, name: e.target.value})} placeholder="Ton pseudo..." />
                                    <select className="flex h-9 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-xs focus:ring-2 focus:ring-primary outline-none" value={claimData.type} onChange={e => setClaimData({...claimData, type: e.target.value})}>
                                      <option value="main">⭐ Base Principale</option>
                                      <option value="sub_1">🏠 Base Secondaire</option>
                                    </select>
                                    <Button size="sm" className="w-full rounded-lg h-8 text-xs" onClick={handleClaimBase} disabled={!claimData.name}>Claim !</Button>
                                  </div>
                                ) : (
                                  <>
                                    {base.created_by && <p className="text-xs text-muted-foreground italic">Signalée par : {base.created_by}</p>}
                                    <div className="p-3 rounded-lg border border-white/5 bg-white/5 flex flex-col items-center gap-2">
                                      <span className="text-xs text-gray-400">Noter cette base :</span>
                                      <div className="flex gap-1">
                                        {[1,2,3,4,5].map(star => (
                                          <button 
                                            key={star} 
                                            onClick={() => handleRate(star)}
                                            disabled={currentUser.isGuest}
                                            className={`transition-all hover:scale-125 disabled:opacity-50 disabled:hover:scale-100 ${star <= myRating ? 'text-yellow-400 drop-shadow-[0_0_5px_rgba(250,204,21,0.5)]' : 'text-gray-600'}`}
                                          >
                                            <StarIcon className={`h-6 w-6 ${star <= myRating ? 'fill-yellow-400' : ''}`} />
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}

                            {activeTab === 'reviews' && (
                              <div className="space-y-3 flex flex-col h-full">
                                <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                                  {baseDetails.reviews.length === 0 ? (
                                    <p className="text-xs text-center text-gray-500 py-4">Aucun message pour le moment.</p>
                                  ) : (
                                    baseDetails.reviews.map(rev => {
                                      const isOwner = rev.player_name.toLowerCase() === base.player_name.toLowerCase()
                                      return (
                                        <div key={rev.id} className={`p-2.5 rounded-lg text-xs border ${isOwner ? 'border-yellow-500/30 bg-yellow-500/10' : 'border-white/5 bg-white/5'}`}>
                                          <div className="flex justify-between items-center mb-1">
                                            <span className={`font-bold ${isOwner ? 'text-yellow-400' : 'text-gray-300'}`}>{rev.player_name} {isOwner && '👑'}</span>
                                            <span className="text-[9px] text-gray-500">{new Date(rev.created_at).toLocaleDateString('fr-FR', {timeZone: 'Europe/Paris', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</span>
                                          </div>
                                          <p className="text-gray-200 break-words leading-relaxed">{rev.content}</p>
                                        </div>
                                      )
                                    })
                                  )}
                                </div>
                                {!currentUser.isGuest && (
                                  <div className="flex gap-2 mt-2 pt-2 border-t border-white/5">
                                    <input type="text" className="flex-1 h-8 rounded-lg border border-white/10 bg-black/40 px-3 text-xs focus:ring-1 focus:ring-primary outline-none" placeholder="Laisser un avis..." value={newReview} onChange={e=>setNewReview(e.target.value)} onKeyDown={e=>e.key === 'Enter' && handlePostReview()} />
                                    <Button size="sm" className="h-8 px-3 rounded-lg" onClick={handlePostReview} disabled={!newReview.trim()}>Ok</Button>
                                  </div>
                                )}
                              </div>
                            )}

                            {activeTab === 'history' && (
                              <div className="space-y-1.5">
                                {baseDetails.visits.length === 0 ? (
                                  <p className="text-xs text-center text-gray-500 py-4">Aucune visite enregistrée récemment.</p>
                                ) : (
                                  baseDetails.visits.map(visit => (
                                    <div key={visit.id} className="flex justify-between items-center p-2 rounded-lg bg-white/5 text-xs">
                                      <span className="font-semibold text-gray-300">{visit.player_name}</span>
                                      <span className="text-[10px] text-gray-500">{new Date(visit.visited_at).toLocaleString('fr-FR', {timeZone: 'Europe/Paris', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</span>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>

                          {/* Footer Actions (Toujours visibles) */}
                          <div className="p-3 border-t border-white/10 bg-black/20 flex gap-2">
                            <Button variant="ghost" size="sm" className="rounded-lg hover:bg-red-500/20 text-red-400 hover:text-red-300 gap-1.5 flex-1 h-8 text-xs" onClick={() => handleDeleteBase(base.id, base.player_name)}>
                              <TrashIcon className="h-3 w-3" /> Suppr.
                            </Button>
                            <Button variant="secondary" size="sm" className="rounded-lg gap-1.5 flex-1 bg-white/10 hover:bg-white/20 h-8 text-xs" onClick={startMovingBase}>
                              <MoveIcon className="h-3 w-3" /> Déplacer
                            </Button>
                          </div>
                        </Card>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ... Les menus latéraux et autres formulaires de bases/boss inchangés par rapport à ta version d'avant ... */}
        
        {/* On garde juste les fenêtres contextuelles de création et signalement Boss */}
      </div>
    </>
  )
}