import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

export type ProgressLogType =
  | 'started'
  | 'thinking'
  | 'action'
  | 'iteration'
  | 'file_edit'
  | 'commit'
  | 'complete'
  | 'error'

// Insert a progress log (will appear in UI via real-time subscription)
export async function logProgress(
  agentRunId: string,
  ticketId: string,
  type: ProgressLogType,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('progress_logs').insert({
    agent_run_id: agentRunId,
    ticket_id: ticketId,
    type,
    message,
    metadata: metadata || {},
  })

  if (error) {
    console.error('Failed to log progress:', error)
  }
}

// Update ticket status
export async function updateTicketStatus(
  ticketId: string,
  status: string,
  prUrl?: string
): Promise<void> {
  const update: Record<string, unknown> = { status }
  if (prUrl) {
    update.pr_url = prUrl
  }

  const { error } = await supabase
    .from('tickets')
    .update(update)
    .eq('id', ticketId)

  if (error) {
    console.error('Failed to update ticket:', error)
  }
}

// Update agent run status
export async function updateAgentRun(
  agentRunId: string,
  status: 'running' | 'complete' | 'failed',
  error?: string
): Promise<void> {
  const update: Record<string, unknown> = {
    status,
    finished_at: status !== 'running' ? new Date().toISOString() : null,
  }
  if (error) {
    update.error = error
  }

  const { error: updateError } = await supabase
    .from('agent_runs')
    .update(update)
    .eq('id', agentRunId)

  if (updateError) {
    console.error('Failed to update agent run:', updateError)
  }
}
