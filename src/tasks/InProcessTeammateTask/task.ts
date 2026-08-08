import type { Task } from '../../Task.js'

/** Lightweight registry entry; load the teammate runtime only when stopping. */
export const InProcessTeammateTask: Task = {
  name: 'InProcessTeammateTask',
  type: 'in_process_teammate',
  async kill(taskId, setAppState) {
    const { killInProcessTeammate } = await import(
      '../../utils/swarm/spawnInProcess.js'
    )
    killInProcessTeammate(taskId, setAppState)
  },
}
