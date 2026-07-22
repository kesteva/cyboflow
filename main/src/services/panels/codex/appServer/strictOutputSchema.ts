/**
 * strictOutputSchema — rewrite a JSON Schema into the STRICT form the Codex
 * app-server (→ OpenAI structured outputs) demands for a turn `outputSchema`.
 *
 * OpenAI strict structured output rejects a schema unless, for EVERY object node,
 * `required` lists ALL of its `properties` (and `additionalProperties` is false).
 * A lenient schema that marks some properties optional — which the Claude SDK's
 * `json_schema` output mode accepts fine — draws a hard 400 from Codex:
 *
 *   invalid_json_schema: 'required' is required to be … an array including every
 *   key in properties. Missing 'subCheckId'.
 *
 * (This is exactly what silently killed the Codex eval juror on 100% of runs — it
 * shares `JUDGE_OUTPUT_SCHEMA` with the Claude jurors, which tolerate the optional
 * keys.) Rather than fork the shared schema, this transform derives the strict
 * variant at the Codex boundary only: it promotes every property to `required` and
 * makes the originally-OPTIONAL ones NULLABLE, so the model can still signal
 * "absent" (emit null) while satisfying the all-required constraint. The eval
 * parser already treats a null/absent optional field identically (see
 * evalJury.parseFindings), so round-tripping is unaffected.
 *
 * Pure + non-mutating: returns freshly-built nodes and never touches the input
 * (the shared exported schema must stay intact for the Claude path).
 */
type JsonSchema = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Add 'null' to a schema node's `type` (and `enum`, if present) idempotently. */
function makeNullable(node: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...node };
  const type = out.type;
  if (typeof type === 'string') {
    out.type = type === 'null' ? type : [type, 'null'];
  } else if (Array.isArray(type)) {
    out.type = type.includes('null') ? type : [...type, 'null'];
  } else if (!('anyOf' in out) && !('oneOf' in out) && !('enum' in out)) {
    // No declared type/union to widen — fall back to an anyOf with a null branch.
    return { anyOf: [node, { type: 'null' }] };
  }
  // A nullable enum must admit null as a member, or the strict validator rejects
  // a returned null that isn't in the enum.
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }
  return out;
}

/**
 * Recursively strict-ify a JSON Schema for Codex `outputSchema`. Every object's
 * `required` becomes the full set of its property keys; properties that were NOT
 * in the source `required` are made nullable. Recurses into `properties`, array
 * `items`, and `anyOf`/`oneOf`/`allOf` branches.
 */
export function toStrictOutputSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };

  if (isSchemaObject(out.properties)) {
    const sourceRequired = new Set(
      Array.isArray(out.required) ? out.required.filter((k): k is string => typeof k === 'string') : [],
    );
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.properties)) {
      let child = isSchemaObject(value) ? toStrictOutputSchema(value) : value;
      if (isSchemaObject(child) && !sourceRequired.has(key)) {
        child = makeNullable(child);
      }
      props[key] = child;
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }

  if (isSchemaObject(out.items)) {
    out.items = toStrictOutputSchema(out.items);
  }

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = out[combinator];
    if (Array.isArray(branches)) {
      out[combinator] = branches.map((b) => (isSchemaObject(b) ? toStrictOutputSchema(b) : b));
    }
  }

  return out;
}
