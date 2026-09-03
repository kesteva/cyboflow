/**
 * buildFirstIdeaContextHint — the hidden `contextHint` (agentThreadStore's
 * `sendMessage` opt) for guided step 10's first send. Never part of the
 * recorded transcript turn.
 *
 * With a project: primes the assistant to read the message as one or more
 * backlog ideas for the project the user just created and steers it toward
 * exactly one `create-backlog-items` proposal — see
 * main/src/orchestrator/agentThread/agentThreadPrompt.ts for that proposal
 * kind's shape (`{kind, projectId, items:[{taskType, title, body?, priority?,
 * ...}]}`).
 *
 * Without one (the "Not sure yet" branch): the user was asked what they want
 * to get done with Cyboflow itself. There is no project to file ideas against,
 * so the assistant explains how the flows fit their goal and points at adding
 * a project as the next step — and proposes NO actions.
 */
export function buildFirstIdeaContextHint(project: { id: number; name: string } | null): string {
  if (project === null) {
    return (
      `[Onboarding context — not visible to the user] The user is on Cyboflow's ` +
      `first-run guided set-up. They have NOT added a project yet (they chose ` +
      `"Not sure yet") and were asked: "What do you want to get done with ` +
      `Cyboflow?" Treat the message below as their goal. Reply in a few friendly ` +
      `sentences: reflect the goal back, say which built-in flow fits it best ` +
      `(Launch to interview a brand-new project into a brief and ideas, Planner ` +
      `to turn ideas into specced tasks, Ship to plan and build one idea end to ` +
      `end, Sprint to build a batch of ready tasks in parallel, or a plain quick ` +
      `session for one-off work) and why, and close by saying the next step is ` +
      `adding a project — from the home screen or the sidebar — after which you ` +
      `can capture their ideas for it. Do NOT propose any action: there is no ` +
      `project to file backlog items against and nothing to launch. Do not ask ` +
      `clarifying questions unless the message carries no intent at all.`
    );
  }
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
