/**
 * Plan progress card for `data-plan` parts.
 *
 * Each `data-plan` chunk is a FULL plan snapshot (one per `planning.*`
 * mutation — created/updated/status_changed/completed/deleted), so the card
 * renders `data.tasks` verbatim with no merging. MessageList keeps only the
 * last `data-plan` part per message (`transcriptParts`), which is why this
 * card can treat its payload as "the" current plan.
 *
 * Status icons follow the Claude Code todo-list idiom: hollow circle for
 * pending, spinner + `active_form` for in-progress, struck-through check for
 * completed.
 */
import {
  CheckCircle2,
  Circle,
  ListTodo,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { asPlanSnapshot, type PlanTask } from '../../lib/dataParts'
import { Collapsible, JsonCard } from './partKit'

const STATUS_ICON: Record<string, LucideIcon> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
}

export function PlanCard({ data }: Readonly<{ data: unknown }>): React.JSX.Element {
  const snapshot = asPlanSnapshot(data)
  if (!snapshot) return <JsonCard title="plan" value={data} />

  // A `deleted` plan arrives as an empty task list — render a quiet
  // tombstone rather than a collapsible that opens onto nothing.
  if (snapshot.tasks.length === 0) {
    return (
      <p className="my-1.5 flex items-center gap-1.5 text-xs text-faint">
        <ListTodo className="h-3.5 w-3.5" />
        Plan cleared
      </p>
    )
  }

  const done = snapshot.tasks.filter((t) => t.status === 'completed').length
  const active = snapshot.tasks.some((t) => t.status === 'in_progress')

  return (
    <Collapsible
      icon={<ListTodo className="h-3.5 w-3.5" />}
      label="Plan"
      badge={`${done}/${snapshot.tasks.length}`}
      // Open while something is running; a finished plan folds away.
      defaultOpen={active}
    >
      <ul className="space-y-1">
        {snapshot.tasks.map((task) => (
          <PlanTaskRow key={task.id} task={task} />
        ))}
      </ul>
    </Collapsible>
  )
}

function PlanTaskRow({ task }: Readonly<{ task: PlanTask }>): React.JSX.Element {
  const Icon = STATUS_ICON[task.status] ?? Circle
  const inProgress = task.status === 'in_progress'
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
          inProgress ? 'animate-spin text-accent' : 'text-faint'
        }`}
      />
      <span
        className={
          task.status === 'completed'
            ? 'text-faint line-through'
            : 'text-secondary'
        }
      >
        {/* In-progress tasks show their present-tense form when provided. */}
        {inProgress && task.active_form ? task.active_form : task.content}
      </span>
    </li>
  )
}
