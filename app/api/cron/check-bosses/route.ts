import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: Request) {
  // Vérification de sécurité avec ton mot de passe "balancoire"
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Non autorisé', { status: 401 })
  }

  const now = new Date().toISOString()
  
  const { data: expiredTimers } = await supabase
    .from('boss_timers')
    .select('*')
    .eq('notified_respawn', false)
    .lte('respawn_time', now)

  if (expiredTimers && expiredTimers.length > 0) {
    for (const timer of expiredTimers) {
      // Envoi du message au serveur Palworld via la bonne URL (avec /v1/api/)
      await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/palworld/v1/api/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Le boss ${timer.name} est de nouveau disponible !` })
      })

      // On verrouille pour ne pas spammer
      await supabase.from('boss_timers').update({ notified_respawn: true }).eq('id', timer.id)
    }
  }

  return NextResponse.json({ success: true, count: expiredTimers?.length || 0 })
}