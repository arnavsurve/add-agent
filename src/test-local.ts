/**
 * Local test script for fly-agent
 *
 * Usage:
 * 1. Create a ticket in the ADD app (http://localhost:3000)
 * 2. Click "Start Agent" to create an agent_run record
 * 3. Copy the ticket ID and agent_run ID from Supabase
 * 4. Run: TICKET_ID=xxx AGENT_RUN_ID=yyy npm run test:local
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const ticketId = process.env.TICKET_ID
  const agentRunId = process.env.AGENT_RUN_ID

  if (!ticketId) {
    console.error('Missing TICKET_ID environment variable')
    console.log('\nUsage: TICKET_ID=xxx AGENT_RUN_ID=yyy npm run test:local')
    console.log('\nTo get these IDs:')
    console.log('1. Create a ticket at http://localhost:3000')
    console.log('2. Click "Start Agent"')
    console.log('3. Check your Supabase dashboard for the ticket and agent_run IDs')
    process.exit(1)
  }

  // Fetch ticket from Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  )

  const { data: ticket, error: ticketError } = await supabase
    .from('tickets')
    .select('*')
    .eq('id', ticketId)
    .single()

  if (ticketError || !ticket) {
    console.error('Ticket not found:', ticketError)
    process.exit(1)
  }

  // Get or use provided agent run ID
  let runId = agentRunId
  if (!runId) {
    // Get the latest agent run for this ticket
    const { data: runs } = await supabase
      .from('agent_runs')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('started_at', { ascending: false })
      .limit(1)

    if (!runs || runs.length === 0) {
      console.error('No agent run found for this ticket. Click "Start Agent" first.')
      process.exit(1)
    }
    runId = runs[0].id
  }

  console.log('Found ticket:', ticket.title)
  console.log('Agent run ID:', runId)
  console.log('Repo:', ticket.repo_url)
  console.log('Branch:', ticket.branch_name)
  console.log('')

  // Set up AGENT_JOB environment variable
  const agentJob = {
    ticketId: ticket.id,
    agentRunId: runId,
    repoUrl: ticket.repo_url,
    branchName: ticket.branch_name,
    title: ticket.title,
    description: ticket.description,
  }

  process.env.AGENT_JOB = JSON.stringify(agentJob)

  console.log('Starting agent...\n')

  // Dynamically import and run the main agent
  await import('./index.js')
}

main().catch(console.error)
