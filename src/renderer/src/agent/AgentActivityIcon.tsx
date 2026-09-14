import { IconBraces, IconCheck, IconCodeSearch, IconFileCode, IconSparkles } from '@pierre/icons'

import type { AgentActivityKind } from '../../../shared/contracts'

export function ActivityIcon({ kind }: { kind: AgentActivityKind }): React.JSX.Element {
  if (kind === 'reasoning' || kind === 'plan') return <IconSparkles aria-hidden="true" />
  if (kind === 'search') return <IconCodeSearch aria-hidden="true" />
  if (kind === 'file') return <IconFileCode aria-hidden="true" />
  if (kind === 'command' || kind === 'tool') return <IconBraces aria-hidden="true" />
  return <IconCheck aria-hidden="true" />
}
