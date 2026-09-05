import type { InputAnswer, InputField, InputValue } from '../policy/types.js';

/** The form schema shared by ACP and MCP clients. */
export function formSchema(fields: readonly InputField[]) {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(fields.map((field) => [field.key, propertyOf(field)])),
    required: fields.filter((field) => field.required).map((field) => field.key),
  };
}

function propertyOf(field: InputField) {
  const base = { title: field.label, ...(field.description ? { description: field.description } : {}) };
  switch (field.kind) {
    case 'boolean':
      return { type: 'boolean' as const, ...base };
    case 'number':
    case 'integer':
      return { type: field.kind, ...base };
    case 'enum':
      return { type: 'string' as const, ...base, enum: (field.options ?? []).map((option) => option.value) };
    case 'multiselect':
      return { type: 'array' as const, ...base,
        items: { type: 'string' as const, enum: (field.options ?? []).map((option) => option.value) } };
    default:
      return { type: 'string' as const, ...base };
  }
}

/** Keep only requested fields and normalize unsupported response actions. */
export function formAnswer(
  fields: readonly InputField[],
  answer: { action: string; content?: Record<string, InputValue> | null },
): InputAnswer {
  if (answer.action !== 'accept') return { action: answer.action === 'decline' ? 'decline' : 'cancel' };
  const content: Record<string, InputValue> = {};
  for (const field of fields) {
    const value = answer.content?.[field.key];
    if (value !== undefined) content[field.key] = value;
  }
  return { action: 'accept', content };
}
