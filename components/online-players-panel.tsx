'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InfoPanel } from '@/components/status-bar'
import { useServer } from '@/lib/server-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { getPlayerKey, normalizePlayersPayload } from '@/lib/palworld'
import { getPlayerAvatarColor } from '@/lib/player-avatar-colors'
import { toast } from 'sonner'
import {
  RefreshCwIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
  WifiIcon
} from 'lucide-react'
import type { Player } from '@/lib/types'

function getPingColor(ping: number) {
  if (ping < 80) return 'text-green-500'
  if (ping < 150) return 'text-yellow-500'
  return 'text-red-500'
}

function getPlayerInitial(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.charAt(0).toUpperCase()
}

export function OnlinePlayersPanel() {
  const { apiCall, players, setPlayers, refreshRate, isLoading, fetchAllData } = useServer()
  const [search, setSearch] = useState('')
  const previousPlayersRef = useRef<Player[]>(players)

  const fetchPlayers = useCallback(async () => {
    try {
      const payload = await apiCall<unknown>('players')
      const newPlayers = normalizePlayersPayload(payload)
      const prevPlayers = previousPlayersRef.current

      if (prevPlayers.length > 0 || newPlayers.length > 0) {
        const prevIds = new Set(prevPlayers.map(getPlayerKey))
        const newIds = new Set(newPlayers.map(getPlayerKey))
        const joined = newPlayers.filter((player) => !prevIds.has(getPlayerKey(player)))
        const left = prevPlayers.filter((player) => !newIds.has(getPlayerKey(player)))

        joined.forEach((player) => {
          toast.success(`${player.name} a rejoint le serveur`, {
            icon: <UserIcon className="w-4 h-4 text-green-500" />,
          })
        })

        left.forEach((player) => {
          toast.info(`${player.name} a quitté le serveur`, {
            icon: <UserIcon className="w-4 h-4 text-yellow-500" />,
          })
        })
      }

      previousPlayersRef.current = newPlayers
      setPlayers(newPlayers)
    } catch {
      // Erreur déjà gérée dans apiCall
    }
  }, [apiCall, setPlayers])

  const hasInitializedRef = useRef(false)
  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
      fetchPlayers()
    }
  }, [fetchPlayers])

  useEffect(() => {
    const interval = setInterval(() => fetchPlayers(), refreshRate * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchPlayers, refreshRate])

  const handleManualRefresh = () => {
    void fetchPlayers()
    void fetchAllData()
  }

  const searchQuery = search.trim().toLowerCase()

  const filteredPlayers = useMemo(() => {
    if (!searchQuery) {
      return players
    }

    return players.filter((player) =>
      player.name.toLowerCase().includes(searchQuery) ||
      player.userId.toLowerCase().includes(searchQuery)
    )
  }, [players, searchQuery])

  return (
    <aside className="flex h-full w-80 min-h-0">
      <InfoPanel title="Joueurs en ligne" subtitle="Registre du serveur" status="active" className="flex h-full min-h-0 w-full flex-col">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-foreground">Effectif</h2>
          </div>
          <Badge variant="secondary" className="px-2 py-1">
            {players.length}
          </Badge>
        </div>

        <div className="space-y-3 flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher un joueur..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={handleManualRefresh}
            disabled={isLoading['players'] || isLoading['info'] || isLoading['metrics'] || isLoading['settings']}
            className="h-9 w-9 border-border shrink-0"
          >
            {isLoading['players'] ? (
              <Spinner className="w-4 h-4" />
            ) : (
              <RefreshCwIcon className="w-4 h-4" />
            )}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 mt-4">
          <div className="p-2">
            {filteredPlayers.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                {search ? 'Aucun joueur trouvé' : 'Aucun joueur en ligne'}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredPlayers.map((player) => {
                  const avatarColor = getPlayerAvatarColor(getPlayerKey(player))
                  return (
                    <div
                      key={getPlayerKey(player)}
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary/50 transition-colors group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="avatar-circle w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border border-white/20"
                          style={{ backgroundColor: avatarColor }}
                        >
                          <span className="font-mono text-sm font-semibold text-white">
                            {getPlayerInitial(player.name)}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{player.name}</p>
                          <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                            Niv. {player.level}
                            {player.accountName && player.accountName !== player.name && (
                              <><span className="mx-0.5">·</span><span className="truncate max-w-20">{player.accountName}</span></>
                            )}
                            <span className="mx-0.5">|</span>
                            <WifiIcon className={`w-3 h-3 ${getPingColor(Math.floor(player.ping ?? 0))}`} />
                            <span className={getPingColor(Math.floor(player.ping ?? 0))}>{Math.floor(player.ping ?? 0)}ms</span>
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </InfoPanel>
    </aside>
  )
}