import type { ComponentProps } from 'react'

import { ViewerProviders } from '../editor/ViewerProviders'
import RepositoryWorkspace, { type RepositoryWorkspaceProps } from './RepositoryWorkspace'

export interface WorkspaceRootProps extends RepositoryWorkspaceProps {
  theme: ComponentProps<typeof ViewerProviders>['theme']
  workspaceKey: string
}

export default function WorkspaceRoot({
  theme,
  workspaceKey,
  ...workspaceProps
}: WorkspaceRootProps): React.JSX.Element {
  return (
    <ViewerProviders theme={theme}>
      <RepositoryWorkspace key={workspaceKey} {...workspaceProps} />
    </ViewerProviders>
  )
}
