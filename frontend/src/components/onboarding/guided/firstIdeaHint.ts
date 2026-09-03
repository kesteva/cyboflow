/**
 * buildFirstIdeaContextHint — the hidden `contextHint` (agentThreadStore's
 * `sendMessage` opt) for guided step 10's first send. Primes the assistant to
 * read the message as one or more backlog ideas for the project the user just
 * created and steers it toward exactly one `create-backlog-items` proposal —
 * see main/src/orchestrator/agentThread/agentThreadPrompt.ts for that
 * proposal kind's shape (`{kind, projectId, items:[{taskType, title, body?,
 * priority?, ...}]}`). Never part of the recorded transcript turn.
 */
export function buildFirstIdeaContextHint(project: { id: number; name: string }): string {
  return (
    `[Onboarding context — not visible to the user] The user is on Cyboflow's ` +
    `first-run guided set-up. They just added the project "${project.name}" ` +
    `(project_id ${project.id}) and were asked: "What's the next thing you ` +
    `want to get done in ${project.name}?" Treat the message below as one or ` +
    `more backlog ideas for that project. Reply in one or two friendly ` +
    `sentences, then propose exactly ONE create-backlog-items action for ` +
    `project ${project.id} with one \`idea\` item per distinct piece of work: ` +
    `a short title, a one-line body restating the intent, and a sensible ` +
    `priority (P1 for a bug that blocks users, otherwise P2). Do not ask ` +
    `clarifying questions unless the message carries no intent at all. The ` +
    `backlog is empty — you do not need to read it first.`
  );
}
