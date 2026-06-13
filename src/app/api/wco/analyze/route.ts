import { NextRequest, NextResponse } from 'next/server'
import { safeFetch, requireAuthResponse, isResilienceError } from '@/lib/resilience'

const BACKEND = process.env.WCO_BACKEND_URL || 'http://localhost:8000'

export async function POST(req: NextRequest) {
  // Sensitive: triggers a backend agent run (Gemini-backed working-capital
  // analysis). Gate it fail-closed — unset token => 503, never open.
  const denied = requireAuthResponse(req, { token: process.env.WCO_API_TOKEN })
  if (denied) return denied

  try {
    const body = await req.json()
    const res = await safeFetch(`${BACKEND}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
      maxAttempts: 3,
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    const status = isResilienceError(err) && err.kind === 'timeout' ? 504 : 502
    return NextResponse.json({ error: (err as Error).message }, { status })
  }
}
