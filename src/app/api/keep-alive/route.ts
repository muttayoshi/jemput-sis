import { NextResponse } from 'next/server'
import { handleKeepAlive } from '@/lib/keepAlive'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const { status, body } = await handleKeepAlive(process.env, request.headers.get('authorization'))
  return NextResponse.json(body, { status })
}
