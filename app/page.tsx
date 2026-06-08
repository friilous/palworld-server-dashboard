import { LiveMap } from '@/components/live-map'
import { OnlinePlayersPanel } from '@/components/online-players-panel'
import { RequireServerConfig } from '@/components/require-server-config'

export default function Home() {
  return (
    <RequireServerConfig>
      <main className="relative w-screen h-screen overflow-hidden bg-background">
        
        {/* La carte en arrière-plan occupant 100% de l'espace */}
        <div className="absolute inset-0 z-0">
          <LiveMap />
        </div>

        {/* Le panneau des joueurs superposé en haut à droite */}
        <div className="absolute top-4 right-4 z-10 w-80 max-h-[calc(100vh-2rem)] overflow-hidden rounded-lg shadow-2xl border border-border/50 bg-background/90 backdrop-blur-md">
          <OnlinePlayersPanel />
        </div>

      </main>
    </RequireServerConfig>
  )
}