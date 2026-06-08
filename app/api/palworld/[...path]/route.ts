import { Buffer } from 'node:buffer'
import { NextRequest, NextResponse } from 'next/server'
// Plus besoin d'importer PALWORLD_PROXY_HEADERS ici

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path: string[] }>
}

interface ProxyServerConfig {
  serverIp: string
  serverPort: number
  adminPassword: string
}

function parsePort(value: string) {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const port = Number.parseInt(value, 10)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }

  return port
}

function buildUpstreamBaseUrl(serverIp: string, serverPort: number) {
  const normalizedHost = serverIp.trim()

  if (!normalizedHost) {
    return null
  }

  try {
    const baseUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(normalizedHost)
      ? new URL(normalizedHost)
      : new URL(`http://${normalizedHost}`)

    baseUrl.port = serverPort.toString()
    baseUrl.pathname = '/'
    baseUrl.search = ''
    baseUrl.hash = ''

    return baseUrl
  } catch {
    return null
  }
}

// ---- C'EST ICI QUE TOUT CHANGE ----
function getServerConfig() {
  // On récupère directement depuis le fichier .env
  const serverIp = process.env.PALWORLD_SERVER_IP ?? ''
  const serverPortRaw = process.env.PALWORLD_REST_API_PORT ?? ''
  const adminPassword = process.env.PALWORLD_ADMIN_PASSWORD ?? ''

  const serverPort = parsePort(serverPortRaw.trim())

  if (!serverIp.trim() || serverPort == null || !adminPassword) {
    return null
  }

  return {
    serverIp: serverIp.trim(),
    serverPort,
    adminPassword,
  } satisfies ProxyServerConfig
}
// -----------------------------------

async function getUpstreamRequestBody(request: NextRequest) {
  const contentType = request.headers.get('content-type')

  if (!contentType?.includes('application/json')) {
    return undefined
  }

  try {
    return JSON.stringify(await request.json())
  } catch {
    return undefined
  }
}

function parseProxyResponse(text: string) {
  if (!text) {
    return { success: true }
  }

  try {
    return JSON.parse(text)
  } catch {
    return { success: true, message: text }
  }
}

async function proxyPalworldRequest(request: NextRequest, { params }: RouteContext, method: 'GET' | 'POST') {
  // Plus besoin de passer "request" à getServerConfig
  const serverConfig = getServerConfig()

  if (!serverConfig) {
    return NextResponse.json({ error: 'Missing server configuration in .env file' }, { status: 400 })
  }

  const upstreamBaseUrl = buildUpstreamBaseUrl(serverConfig.serverIp, serverConfig.serverPort)

  if (!upstreamBaseUrl) {
    return NextResponse.json({ error: 'Invalid server host or REST API port' }, { status: 400 })
  }

  const { path } = await params
  const upstreamPath = path.map((segment) => encodeURIComponent(segment)).join('/')
  const upstreamUrl = new URL(`/v1/api/${upstreamPath}`, upstreamBaseUrl)
  const body = method === 'POST' ? await getUpstreamRequestBody(request) : undefined

  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`admin:${serverConfig.adminPassword}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
    })
    const text = await response.text()

    if (!response.ok) {
      return NextResponse.json(
        { error: `Server responded with ${response.status}: ${text}` },
        { status: response.status }
      )
    }

    return NextResponse.json(parseProxyResponse(text))
  } catch (error) {
    console.error('Proxy error:', error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect to server' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyPalworldRequest(request, context, 'GET')
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyPalworldRequest(request, context, 'POST')
}