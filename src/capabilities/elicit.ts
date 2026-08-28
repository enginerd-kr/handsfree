import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
} from '@agentclientprotocol/sdk';
import type { InputField, InputValue } from '../policy/types.js';
import type { HostContext } from './context.js';

/**
 * Gate D, and the only one that is not about a side effect. An agent that has
 * stopped because it needs to know something — which of two approaches, a name,
 * a yes — asks here, and handsfree puts the question in front of the person
 * instead of letting the turn end on a question nobody was shown.
 *
 * Only form mode is answered, because form mode is the only one handsfree
 * advertises: sending a user to a URL is a seat we do not have, and a mode we
 * never claimed is declined rather than half-served.
 */
export function createElicitationHandler(host: HostContext) {
  return async (
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> => {
    const sessionId = 'sessionId' in params ? (params.sessionId as string) : '';

    if (params.mode !== 'form') {
      host.transcript.append({
        type: 'note',
        level: 'warn',
        text: `${host.agentId} asked for a "${params.mode}" question, which handsfree does not offer; declined.`,
      });
      return { action: 'decline' };
    }

    // `mode: "form"` narrows to the form variant, but the union carries an
    // open-ended one too, so the schema arrives typed as unknown.
    const fields = fieldsOf(params.requestedSchema as ElicitationSchema | undefined);
    if (fields.length === 0) {
      host.transcript.append({
        type: 'note',
        level: 'warn',
        text: `${host.agentId} asked a question with no fields to answer; declined.`,
      });
      return { action: 'decline' };
    }

    const answer = await host.policy.elicit(
      { agentId: host.agentId, sessionId },
      { summary: params.message, fields },
      { ...(signal ? { signal } : {}) },
    );

    if (answer.action === 'accept') {
      host.transcript.append({
        type: 'note',
        level: 'info',
        text: `answered ${host.agentId}: ${describeAnswer(fields, answer.content)}`,
      });
      return { action: 'accept', content: answer.content };
    }

    host.transcript.append({
      type: 'note',
      level: 'warn',
      text:
        answer.action === 'decline'
          ? `declined to answer ${host.agentId}: ${params.message}`
          : `${host.agentId} asked "${params.message}" and nobody was there to answer`,
    });
    return { action: answer.action };
  };
}

/**
 * The agent's JSON Schema as a list of things to ask, in the order it wrote
 * them. A property whose type handsfree cannot render is dropped rather than
 * shown as something it is not — and a schema where that leaves nothing is a
 * question we decline instead of answering with an empty object.
 */
function fieldsOf(schema: ElicitationSchema | undefined): InputField[] {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const fields: InputField[] = [];

  for (const [key, property] of Object.entries(properties)) {
    const field = fieldOf(key, property, required.has(key));
    if (field) fields.push(field);
  }
  return fields;
}

function fieldOf(
  key: string,
  property: ElicitationPropertySchema,
  required: boolean,
): InputField | undefined {
  const shape = property as ElicitationPropertySchema & {
    title?: string | null;
    description?: string | null;
    default?: unknown;
    enum?: string[] | null;
    oneOf?: { const: string; title: string }[] | null;
    items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };
  };
  const base = {
    key,
    label: shape.title || key,
    required,
    ...(shape.description ? { description: shape.description } : {}),
  };

  switch (property.type) {
    case 'string': {
      const options = choicesOf(shape.enum ?? undefined, shape.oneOf ?? undefined);
      return {
        ...base,
        kind: options ? 'enum' : 'string',
        ...(options ? { options } : {}),
        ...(typeof shape.default === 'string' ? { default: shape.default } : {}),
      };
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: property.type,
        ...(typeof shape.default === 'number' ? { default: shape.default } : {}),
      };
    case 'boolean':
      return {
        ...base,
        kind: 'boolean',
        ...(typeof shape.default === 'boolean' ? { default: shape.default } : {}),
      };
    case 'array': {
      const options = choicesOf(shape.items?.enum, shape.items?.anyOf);
      if (!options) return undefined;
      return {
        ...base,
        kind: 'multiselect',
        options,
        ...(Array.isArray(shape.default) ? { default: shape.default as string[] } : {}),
      };
    }
    default:
      return undefined;
  }
}

function choicesOf(
  values: string[] | undefined,
  titled: { const: string; title: string }[] | undefined,
): { value: string; label: string }[] | undefined {
  if (titled && titled.length > 0) {
    return titled.map((option) => ({ value: option.const, label: option.title || option.const }));
  }
  if (values && values.length > 0) return values.map((value) => ({ value, label: value }));
  return undefined;
}

/** One line for the record: what the user actually told the agent. */
function describeAnswer(fields: InputField[], content: Record<string, InputValue>): string {
  const said = fields
    .filter((field) => content[field.key] !== undefined)
    .map((field) => {
      const value = content[field.key];
      return `${field.label} = ${Array.isArray(value) ? value.join(', ') : String(value)}`;
    });
  return said.length > 0 ? said.join('; ') : 'nothing';
}
