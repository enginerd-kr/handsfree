/**
 * The planner's own name in a mention. It is not an agent — it is the thing
 * that chooses one — so a mention of it names two: the agent that plans and
 * the model it plans on. Reserved at config load, because a name that means
 * an agent and the planner at once means neither.
 */
export const ORCHESTRATOR = 'orchestrator';
