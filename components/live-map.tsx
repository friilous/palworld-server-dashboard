'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { 
  MapPinIcon, ZoomInIcon, ZoomOutIcon, CrosshairIcon, SwordsIcon, 
  BellIcon, TrashIcon, XIcon, MoveIcon, StarIcon, LogOutIcon, 
  UserIcon, MessageSquareIcon, ClockIcon, PencilIcon, CheckIcon 
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
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

  // Nouveaux states pour le compte et les features sociales
  const [currentUser, setCurrentUser] = useState<string | null>(null)
  const [unclaimedPlayers, setUnclaimedPlayers] = useState<any[]>([])
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(true)

  // States pour la base sélectionnée (Avis, Notes, Visites)
  const [baseReviews, setBaseReviews] = useState<any[]>([])
  const [baseRatings, setBaseRatings] = useState<any[]>([])
  const [baseVisits, setBaseVisits] = useState<any[]>([])
  const [newReviewContent, setNewReviewContent] = useState('')
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null)
  const [editingReviewContent, setEditingReviewContent] = useState('')

  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const mapPlaneRef = useRef<HTMLDivElement | null>(null)
  
  // Ref pour éviter de spammer la BDD avec les visites
  const recordedVisitsRef = useRef<Set<string>>(new Set())

  const scale = 1 + zoom * 0.45
  const mappablePlayers = useMemo(() => players.filter((player) => player.location_x !== 0 || player.location_y !== 0), [players])

  // --- INITIALISATION DU JOUEUR ---
  useEffect(() => {
    const savedUser = localStorage.getItem('palworld_current_user')
    if (savedUser) {
      setCurrentUser(savedUser)
      setIsAuthModalOpen(false)
    } else {
      fetchUnclaimedPlayers()
    }
  }, [])

  const fetchUnclaimedPlayers = async () => {
    const { data } = await supabase.from('known_players').select('*').eq('claimed_by', false)
    if (data) setUnclaimedPlayers(data)
  }

  const handleSelectUser = async (playerName: string, isUnknown: boolean = false) => {
    if (!isUnknown) {
      await supabase.from('known_players').update({ claimed_by: true }).eq('name', playerName)
    }
    const finalName = isUnknown ? 'Inconnu' : playerName
    localStorage.setItem('palworld_current_user', finalName)
    setCurrentUser(finalName)
    setIsAuthModalOpen(false)
  }

  const handleDisconnect = async () => {
    if (currentUser && currentUser !== 'Inconnu') {
      await supabase.from('known_players').update({ claimed_by: false }).eq('name', currentUser)
    }
    localStorage.removeItem('palworld_current_user')
    setCurrentUser(null)
    setIsAuthModalOpen(true)
    fetchUnclaimedPlayers()
  }

  // --- LOGIQUE DES BASES ET CLUSTERS ---
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

  // --- AUTOMATISATION DES VISITES ---
  useEffect(() => {
    basesWithPlayers.forEach(base => {
      base.players.forEach((p: any) => {
        const visitKey = `${base.id}-${p.name}`
        if (!recordedVisitsRef.current.has(visitKey)) {
          recordedVisitsRef.current.add(visitKey)
          // On insère en BDD la visite
          supabase.from('base_visits').insert([{
            base_id: base.id,
            player_name: p.name,
            visited_at: new Date().toISOString()
          }]).then()
        }
      })
    })
  }, [basesWithPlayers])

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

  // --- FETCH DES INFOS LORSQU'UNE BASE EST SELECTIONNEE ---
  useEffect(() => {
    if (!selectedBase) return

    const fetchBaseDetails = async () => {
      const [reviewsRes, ratingsRes, visitsRes] = await Promise.all([
        supabase.from('base_reviews').select('*').eq('base_id', selectedBase.id).order('created_at', { ascending: false }),
        supabase.from('base_ratings').select('*').eq('base_id', selectedBase.id),
        supabase.from('base_visits').select('*').eq('base_id', selectedBase.id).order('visited_at', { ascending: false }).limit(10)
      ])
      if (reviewsRes.data) setBaseReviews(reviewsRes.data)
      if (ratingsRes.data) setBaseRatings(ratingsRes.data)
      if (visitsRes.data) setBaseVisits(visitsRes.data)
    }

    fetchBaseDetails()
  }, [selectedBase])


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

    const baseType = formData.isUnknown ? 'main' : formData.type
    const playerName = formData.isUnknown ? 'Base Inconnue' : formData.name
    const guildName = formData.isUnknown ? null : formData.faction

    const { error } = await supabase.from('player_bases').insert([{
      player_name: playerName, 
      guild_name: guildName,
      base_type: baseType, 
      location_x: newBaseCoords.x, 
      location_y: newBaseCoords.y,
      created_by: currentUser // Ajout de qui a trouvé/créé la base
    }])
    
    if (error) {
      console.error("Erreur lors de la création :", error)
      alert("Erreur lors de l'ajout de la base : " + error.message)
      return
    }

    setIsAddingBase(false); 
    setNewBaseCoords(null); 
    setFormData({ name: '', faction: '', type: 'main', isUnknown: false })
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

  // --- RATING & REVIEWS LOGIC ---
  const handleRateBase = async (rating: number) => {
    if (!currentUser || currentUser === 'Inconnu' || !selectedBase) return

    const existingRating = baseRatings.find(r => r.player_name === currentUser)
    
    if (existingRating) {
      await supabase.from('base_ratings').update({ rating }).eq('id', existingRating.id)
      setBaseRatings(prev => prev.map(r => r.id === existingRating.id ? { ...r, rating } : r))
    } else {
      const { data } = await supabase.from('base_ratings').insert([{
        base_id: selectedBase.id, player_name: currentUser, rating
      }]).select().single()
      if (data) setBaseRatings([...baseRatings, data])
    }
  }

  const submitReview = async () => {
    if (!newReviewContent.trim() || !currentUser || currentUser === 'Inconnu' || !selectedBase) return

    const { data } = await supabase.from('base_reviews').insert([{
      base_id: selectedBase.id,
      player_name: currentUser,
      content: newReviewContent
    }]).select().single()

    if (data) {
      setBaseReviews([data, ...baseReviews])
      setNewReviewContent('')
    }
  }

  const handleEditReview = async (id: string) => {
    if (!editingReviewContent.trim()) return
    await supabase.from('base_reviews').update({ content: editingReviewContent }).eq('id', id)
    setBaseReviews(prev => prev.map(r => r.id === id ? { ...r, content: editingReviewContent } : r))
    setEditingReviewId(null)
  }

  const handleDeleteReview = async (id: string) => {
    if (window.confirm("Supprimer ce commentaire ?")) {
      await supabase.from('base_reviews').delete().eq('id', id)
      setBaseReviews(prev => prev.filter(r => r.id !== id))
    }
  }

  const averageRating = baseRatings.length > 0 
    ? (baseRatings.reduce((acc, curr) => acc + curr.rating, 0) / baseRatings.length).toFixed(1) 
    : 0


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

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return 
    event.preventDefault() 
    
    if (selectedBase) setSelectedBase(null)

    dragStartRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    setIsDragging(true)
  }, [pan.x, pan.y, selectedBase])

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

  const handleBaseClick = (e: React.MouseEvent, base: any) => {
    e.stopPropagation() 
    setSelectedBase(base)

    const [mapX, mapY] = toMapPosition([base.location_x, base.location_y])
    
    const percentLeft = mapY / 256
    const percentTop = -mapX / 256
    
    const targetPanX = (0.5 - percentLeft) * 1024
    const targetPanY = (0.5 - percentTop) * 1024

    setPan({ x: targetPanX, y: targetPanY })
  }

  const activeBossTimers = bossTimers.filter(t => new Date(t.respawn_time) > new Date())

  return (
    <>
      {/* MODAL DE CONNEXION / SELECTION DE COMPTE */}
      {isAuthModalOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <Card className="w-full max-w-md p-6 shadow-2xl border-white/10 bg-background/95 backdrop-blur-xl rounded-2xl text-center space-y-6">
            <h2 className="text-2xl font-bold">Qui es-tu ?</h2>
            <p className="text-sm text-muted-foreground">
              Sélectionne ton compte pour lier tes actions (bases, avis, notes). Si tu n'es pas dans la liste, connecte-toi une fois au serveur en jeu.
            </p>
            
            <div className="max-h-[300px] overflow-y-auto space-y-2 text-left custom-scrollbar p-1">
              {unclaimedPlayers.map(p => (
                <Button key={p.name} variant="outline" className="w-full justify-start h-12" onClick={() => handleSelectUser(p.name)}>
                  <UserIcon className="mr-3 h-5 w-5 text-primary" /> {p.name}
                </Button>
              ))}
              {unclaimedPlayers.length === 0 && (
                <div className="text-center p-4 text-sm text-gray-400 italic border border-white/5 rounded-lg bg-white/5">
                  Aucun joueur non assigné trouvé.
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-white/10">
              <Button variant="ghost" className="w-full text-gray-400 hover:text-white" onClick={() => handleSelectUser('Inconnu', true)}>
                Continuer en tant qu'Inconnu
              </Button>
            </div>
          </Card>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-4rem)] w-full overflow-hidden bg-background text-foreground relative font-sans">
        
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

        {/* BARRE UTILISATEUR EN BAS AU MILIEU */}
        {currentUser && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-black/80 backdrop-blur-xl border border-white/10 px-4 py-2 rounded-full shadow-2xl">
            <UserIcon className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold text-white">
              {currentUser}
            </span>
            <button onClick={handleDisconnect} className="ml-2 text-gray-400 hover:text-red-400 transition-colors p-1" title="Changer de compte">
              <LogOutIcon className="h-4 w-4" />
            </button>
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

              {showFastTravels && fastTravelMarkers.map((marker) => (
                <div key={marker.key} className="absolute z-10 flex items-center justify-center" style={{ ...marker.position, transform: `translate(-50%, -50%) scale(${1 / scale})` }}>
                  <img src="/palworld-map/fast_travel.webp" alt="Fast Travel" className="h-6 w-6 object-contain drop-shadow-md" draggable={false} />
                </div>
              ))}

              {showBases && basesWithPlayers.map((base) => {
                const position = toScreenPercent([base.location_x, base.location_y])
                const isUnknown = base.player_name === 'Base Inconnue'
                const isMain = base.base_type === 'main'
                const isActive = base.players && base.players.length > 0
                const isSelected = selectedBase?.id === base.id

                return (
                  <div 
                    key={base.id} 
                    className={`absolute cursor-pointer group ${isSelected ? 'z-[60]' : 'z-20'}`} 
                    style={{ ...position, transform: `translate(-50%, -50%) scale(${1 / scale})` }} 
                    onClick={(e) => handleBaseClick(e, base)}
                  >
                    
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
                      className={`relative z-10 drop-shadow-xl transition-transform duration-300 group-hover:scale-125 object-contain -translate-y-1/2 ${isUnknown ? "h-10 w-10 opacity-80" : isMain ? "h-14 w-14" : "h-8 w-8"}`} 
                      draggable={false} 
                    />
                    
                    {!isSelected && (
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
                        <span className="mt-1.5 text-[9px] text-primary/80 font-normal italic">Clic pour voir la fiche</span>
                      </div>
                    )}

                    {/* FICHE D'INFORMATION COMPLETE */}
                    {isSelected && (
                      <div 
                        className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 cursor-default animate-in fade-in zoom-in-95 duration-200"
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Card className="w-[340px] max-h-[400px] overflow-y-auto custom-scrollbar p-4 shadow-2xl shadow-black/50 border-white/10 bg-background/95 backdrop-blur-xl rounded-xl relative flex flex-col gap-4">
                          
                          <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-background/95 border-l border-t border-white/10 rotate-45" />

                          <button onClick={() => setSelectedBase(null)} className="absolute top-3 right-3 text-gray-400 hover:text-white transition-colors z-10">
                            <XIcon className="h-4 w-4" />
                          </button>
                          
                          {/* HEADER FICHE */}
                          <div className="flex items-start gap-3 relative z-10">
                            <div className="h-10 w-10 mt-1 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                              <MapPinIcon className="h-5 w-5 text-primary" />
                            </div>
                            <div className="min-w-0 pr-6">
                              <h3 className="text-base font-bold truncate">{isUnknown ? 'Base Inconnue' : base.player_name}</h3>
                              <p className="text-xs text-muted-foreground mb-1">
                                {isUnknown ? 'Non revendiquée' : base.base_type === 'main' ? 'Base Principale' : 'Base Secondaire'}
                              </p>
                              {base.created_by && (
                                <p className="text-[10px] text-gray-400 italic">Découverte par : {base.created_by}</p>
                              )}
                              
                              {/* NOTE MOYENNE */}
                              {!isUnknown && (
                                <div className="flex items-center gap-1 mt-1">
                                  <StarIcon className="h-3 w-3 text-yellow-400 fill-yellow-400" />
                                  <span className="text-xs font-bold">{averageRating}</span>
                                  <span className="text-[10px] text-gray-400">({baseRatings.length} avis)</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* SYSTEME DE VOTE ETOILES */}
                          {!isUnknown && currentUser && currentUser !== 'Inconnu' && (
                            <div className="flex items-center justify-between p-2 rounded-lg bg-white/5 border border-white/5 text-sm">
                              <span className="text-xs text-gray-300">Ta note :</span>
                              <div className="flex gap-1">
                                {[1, 2, 3, 4, 5].map(star => {
                                  const myRating = baseRatings.find(r => r.player_name === currentUser)?.rating || 0
                                  return (
                                    <button key={star} onClick={() => handleRateBase(star)} className="hover:scale-110 transition-transform">
                                      <StarIcon className={`h-4 w-4 ${star <= myRating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-500'}`} />
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {isUnknown ? (
                            <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5 relative z-10">
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
                              {/* SECTIONS AVIS */}
                              <div className="space-y-2 relative z-10">
                                <h4 className="text-xs font-bold flex items-center gap-2"><MessageSquareIcon className="h-3 w-3" /> Commentaires</h4>
                                
                                {currentUser && currentUser !== 'Inconnu' && (
                                  <div className="flex gap-2">
                                    <input 
                                      type="text" 
                                      placeholder="Laisse un avis..." 
                                      className="flex h-8 w-full rounded-lg border border-white/10 bg-black/40 px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
                                      value={newReviewContent}
                                      onChange={(e) => setNewReviewContent(e.target.value)}
                                      onKeyDown={(e) => { if (e.key === 'Enter') submitReview() }}
                                    />
                                    <Button size="sm" className="h-8 px-2" onClick={submitReview}>OK</Button>
                                  </div>
                                )}

                                <div className="space-y-2 max-h-[120px] overflow-y-auto custom-scrollbar pr-1">
                                  {baseReviews.map(review => {
                                    const isOwner = review.player_name === base.player_name
                                    const isMe = review.player_name === currentUser
                                    const isEditing = editingReviewId === review.id

                                    return (
                                      <div key={review.id} className={`p-2 rounded-lg text-xs flex flex-col gap-1 ${isOwner ? 'bg-primary/10 border border-primary/30' : 'bg-white/5 border border-white/5'}`}>
                                        <div className="flex justify-between items-center">
                                          <span className={`font-bold ${isOwner ? 'text-primary' : 'text-gray-300'}`}>
                                            {review.player_name} {isOwner && <span className="text-[9px] bg-primary/20 px-1 rounded ml-1">Proprio</span>}
                                          </span>
                                          <span className="text-[9px] text-gray-500">
                                            {new Date(review.created_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                                          </span>
                                        </div>
                                        
                                        {isEditing ? (
                                          <div className="flex gap-1 mt-1">
                                            <input type="text" className="h-6 flex-1 bg-black/50 border border-white/20 rounded px-1 text-xs outline-none" value={editingReviewContent} onChange={e => setEditingReviewContent(e.target.value)} autoFocus />
                                            <button onClick={() => handleEditReview(review.id)} className="text-green-400"><CheckIcon className="h-3 w-3" /></button>
                                            <button onClick={() => setEditingReviewId(null)} className="text-red-400"><XIcon className="h-3 w-3" /></button>
                                          </div>
                                        ) : (
                                          <div className="flex justify-between items-start group/review">
                                            <p className="text-gray-200 break-words flex-1 pr-2">{review.content}</p>
                                            {isMe && (
                                              <div className="opacity-0 group-hover/review:opacity-100 flex gap-1 transition-opacity shrink-0">
                                                <button onClick={() => { setEditingReviewId(review.id); setEditingReviewContent(review.content); }} className="text-gray-400 hover:text-white"><PencilIcon className="h-3 w-3" /></button>
                                                <button onClick={() => handleDeleteReview(review.id)} className="text-gray-400 hover:text-red-400"><TrashIcon className="h-3 w-3" /></button>
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })}
                                  {baseReviews.length === 0 && <p className="text-[10px] text-gray-500 italic text-center">Aucun commentaire.</p>}
                                </div>
                              </div>

                              {/* SECTION HISTORIQUE VISITES */}
                              <div className="space-y-2 relative z-10 pt-2 border-t border-white/10">
                                <h4 className="text-xs font-bold flex items-center gap-2"><ClockIcon className="h-3 w-3" /> Dernières visites</h4>
                                <div className="max-h-[80px] overflow-y-auto custom-scrollbar flex flex-col gap-1 pr-1">
                                  {baseVisits.map(visit => (
                                    <div key={visit.id} className="flex justify-between items-center text-[10px] text-gray-400">
                                      <span>👤 {visit.player_name}</span>
                                      <span>{new Date(visit.visited_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
                                    </div>
                                  ))}
                                  {baseVisits.length === 0 && <p className="text-[10px] text-gray-500 italic text-center">Aucune visite enregistrée.</p>}
                                </div>
                              </div>
                            </>
                          )}

                          <div className="flex gap-2 justify-between pt-3 border-t border-white/10 relative z-10">
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
              <Button onClick={() => setIsAddingBase(true)} disabled={isAddingBase || movingBaseId !== null} className="w-full gap-2 bg-primary/90 hover:bg-primary shadow-lg shadow-primary/20 transition-all rounded-xl disabled:opacity-50">
                <MapPinIcon className="h-4 w-4" /> {isAddingBase ? 'Placement en cours...' : 'Signaler une base'}
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
              
              <label className="flex items-center gap-3 p-3 border border-white/10 rounded-xl bg-black/20 cursor-pointer hover:bg-white/5 transition-colors">
                <Switch checked={formData.isUnknown} onCheckedChange={(c) => setFormData({...formData, isUnknown: c})} />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">Base Inconnue (À claim)</span>
                  <span className="text-[10px] text-muted-foreground">Coche si tu as trouvé une base au pif</span>
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