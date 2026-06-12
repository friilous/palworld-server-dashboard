'use client'

import { useCallback, useEffect, useState } from 'react'
import { InfoPanel } from '@/components/status-bar'
import { useServer } from '@/lib/server-context'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getPlayerKey, normalizePlayersPayload } from '@/lib/palworld'
import { getPlayerAvatarColor } from '@/lib/player-avatar-colors'
import { toast } from 'sonner'
import { UserIcon, UsersIcon, WifiIcon, MapPinnedIcon } from 'lucide-react'
import { supabase } from '@/lib/supabase'

function getPingColor(ping: number) {
  if (ping < 80) return 'text-green-500'
  if (ping < 150) return 'text-yellow-500'
  return 'text-red-500'
}

function getPlayerInitial(name: string) {
  const trimmed = name?.trim() || '?'
  return trimmed.charAt(0).toUpperCase()
}

export function OnlinePlayersPanel() {
  const { apiCall, setPlayers, refreshRate } = useServer()
  const [allPlayersList, setAllPlayersList] = useState<any[]>([])

  const fetchAndMergePlayers = useCallback(async () => {
    try {
      // 1. Récupération des joueurs en ligne depuis le serveur de jeu
      const payload = await apiCall<unknown>('players')
      const onlinePlayers = normalizePlayersPayload(payload)
      setPlayers(onlinePlayers) // Met à jour le contexte (pour la carte)

      // 2. Sauvegarde des joueurs en ligne dans Supabase (Historique)
      if (onlinePlayers.length > 0) {
        const upsertData = onlinePlayers.map(p => ({
          player_uid: getPlayerKey(p),
          name: p.name,
          level: p.level,
          account_name: p.accountName || p.name,
          location_x: p.location_x,
          location_y: p.location_y,
          last_seen: new Date().toISOString()
        }))
        await supabase.from('known_players').upsert(upsertData)
      }

      // 3. Récupération de TOUS les joueurs connus depuis Supabase
      const { data: dbPlayers } = await supabase.from('known_players').select('*')
      
      // 4. Fusion des données (Pour savoir qui est En Ligne ou Hors-Ligne)
      const onlineIds = new Set(onlinePlayers.map(p => getPlayerKey(p)))
      
      const merged = (dbPlayers || []).map(dbPlayer => {
        const isOnline = onlineIds.has(dbPlayer.player_uid)
        const liveData = onlinePlayers.find(p => getPlayerKey(p) === dbPlayer.player_uid)
        
        return {
          ...dbPlayer,
          isOnline,
          ping: liveData ? liveData.ping : 0,
          location_x: liveData ? liveData.location_x : dbPlayer.location_x,
          location_y: liveData ? liveData.location_y : dbPlayer.location_y,
        }
      })

      // 5. Tri : Connectés en haut, puis par niveau décroissant
      merged.sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || b.level - a.level)
      setAllPlayersList(merged)

    } catch (e) {
      console.error("Erreur de récupération des joueurs:", e)
    }
  }, [apiCall, setPlayers])

  useEffect(() => {
      fetchAndMergePlayers()
      // On retire le "* 60" pour que le refreshRate soit en secondes
      const interval = setInterval(() => fetchAndMergePlayers(), refreshRate * 1000)
      return () => clearInterval(interval)
    }, [fetchAndMergePlayers, refreshRate])

  const handlePlayerClick = (player: any) => {
    // Ne centre la map que si on a des coordonnées (X, Y non nuls)
    if (player.location_x !== 0 || player.location_y !== 0) {
      window.dispatchEvent(new CustomEvent('palworld:center_map', {
        detail: { x: player.location_x, y: player.location_y }
      }))
    }
  }

  const onlineCount = allPlayersList.filter(p => p.isOnline).length

  return (
    <aside className="flex h-full w-80 min-h-0">
      <InfoPanel title="Joueurs" subtitle="Historique du serveur" status="active" className="flex h-full min-h-0 w-full flex-col">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-foreground">Effectif</h2>
          </div>
          <Badge variant="secondary" className="px-2 py-1">
            {onlineCount} / {allPlayersList.length}
          </Badge>
        </div>

        <ScrollArea className="min-h-0 flex-1 mt-2">
          <div className="p-2 space-y-1">
            {allPlayersList.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                Aucun joueur enregistré
              </div>
            ) : (
              allPlayersList.map((player) => {
                const avatarColor = player.isOnline ? getPlayerAvatarColor(player.player_uid) : '#555555'
                
                return (
                  <div
                    key={player.player_uid}
                    onClick={() => handlePlayerClick(player)}
                    className={`flex items-center justify-between p-2 rounded-lg transition-colors group cursor-pointer border ${player.isOnline ? 'hover:bg-secondary/50 border-transparent' : 'opacity-60 hover:opacity-100 hover:bg-white/5 border-transparent'}`}
                    title={player.isOnline ? "Centrer la carte sur ce joueur" : "Dernière position connue"}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative">
                        <div
                          className={`avatar-circle w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border ${player.isOnline ? 'border-white/20' : 'border-black/40 grayscale'}`}
                          style={{ backgroundColor: avatarColor }}
                        >
                          <span className="font-mono text-sm font-semibold text-white">
                            {getPlayerInitial(player.name)}
                          </span>
                        </div>
                        {/* Indicateur de statut (Pastille verte ou grise) */}
                        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${player.isOnline ? 'bg-green-500' : 'bg-gray-500'}`} />
                      </div>
                      
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${player.isOnline ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {player.name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                          Niv. {player.level}
                          {player.isOnline && (
                            <>
                              <span className="mx-0.5">|</span>
                              <WifiIcon className={`w-3 h-3 ${getPingColor(Math.floor(player.ping ?? 0))}`} />
                              <span className={getPingColor(Math.floor(player.ping ?? 0))}>{Math.floor(player.ping ?? 0)}ms</span>
                            </>
                          )}
                          {!player.isOnline && (
                            <>
                              <span className="mx-0.5">|</span>
                              <span className="text-[10px] italic">Hors-ligne</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    
                    {/* Icône qui apparait au survol pour indiquer le clic */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <MapPinnedIcon className={`w-4 h-4 ${player.isOnline ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </InfoPanel>
    </aside>
  )
}