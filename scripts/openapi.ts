/**
 * docs/openapi.json: the commands and queries another system uses, as OpenAPI 3.1. Inputs are the contract's own zod schemas; outputs are
 * read from the contract's TypeScript types by the compiler, so neither is written twice.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { commands, PUBLISHED, queries } from "../packages/contracts/src/api";

type Schema = Record<string, unknown>;
const SOURCE = fileURLToPath(new URL("../packages/contracts/src/api.ts", import.meta.url));
const CONTRACTS = fileURLToPath(new URL("../packages/contracts/src/", import.meta.url));
const REF = "#/components/schemas/";

/** The JSON Schema of the types of `CommandOutputs` and `QueryOutputs`; named types of the contracts become components, so a type may hold itself. */
function outputSchemas(components: Record<string, Schema>): (map: "CommandOutputs" | "QueryOutputs", name: string) => Schema {
  const program = ts.createProgram([SOURCE], { strict: true, exactOptionalPropertyTypes: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(SOURCE) as ts.SourceFile;

  const nameOf = (type: ts.Type): string | undefined => {
    const symbol = type.aliasSymbol ?? (type.getFlags() & ts.TypeFlags.Object ? type.getSymbol() : undefined);
    if (!symbol || symbol.getName().startsWith("__") || type.aliasTypeArguments?.length) return undefined;
    return symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(CONTRACTS) ? symbol.getName() : undefined;
  };
  const object = (type: ts.Type): Schema => {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const held = checker.getTypeOfSymbolAtLocation(property, source);
      properties[property.getName()] = convert(held);
      // A field that may be undefined is a field that may be left out: JSON has no undefined.
      const leftOut = (property.getFlags() & ts.SymbolFlags.Optional) !== 0 || (held.isUnion() && held.types.some((member) => member.getFlags() & ts.TypeFlags.Undefined));
      if (!leftOut) required.push(property.getName());
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return { type: "object", ...(Object.keys(properties).length > 0 ? { properties } : {}), ...(required.length > 0 ? { required: required.sort() } : {}), ...(index ? { additionalProperties: convert(index) } : {}) };
  };
  const union = (members: readonly ts.Type[]): Schema => {
    const there = members.filter((member) => !(member.getFlags() & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)));
    const booleans = there.filter((member) => member.getFlags() & ts.TypeFlags.BooleanLiteral);
    const rest = booleans.length === 2 ? [...there.filter((member) => !booleans.includes(member))] : there;
    const strings = rest.filter((member) => member.isStringLiteral()).map((member) => (member as ts.StringLiteralType).value);
    const others = rest.filter((member) => !member.isStringLiteral()).map(convert);
    const options = [...(booleans.length === 2 ? [{ type: "boolean" }] : []), ...(strings.length > 0 ? [{ type: "string", enum: strings.sort() }] : []), ...others];
    return options.length === 1 ? (options[0] as Schema) : options.length === 0 ? {} : { anyOf: options };
  };
  const shape = (type: ts.Type): Schema => {
    const flags = type.getFlags();
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & ts.TypeFlags.String) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value };
    if (flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === "true" };
    if (type.isUnion()) return union(type.types);
    if (checker.isArrayType(type) || checker.isTupleType(type)) return { type: "array", items: union((checker.getTypeArguments(type as ts.TypeReference)) as ts.Type[]) };
    return object(type);
  };
  function convert(type: ts.Type): Schema {
    // Any JSON value holds itself without end: it is said as what it is, anything.
    if (type.aliasSymbol?.getName() === "JsonValue") return {};
    const name = nameOf(type);
    if (name === undefined) return shape(type);
    if (!(name in components)) {
      components[name] = {};
      components[name] = shape(type);
    }
    return { $ref: `${REF}${name}` };
  }
  return (map, name) => {
    const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === map) as ts.InterfaceDeclaration;
    const property = checker.getPropertyOfType(checker.getTypeAtLocation(declaration), name);
    if (!property) throw new Error(`${map} has no ${name}`);
    return convert(checker.getTypeOfSymbolAtLocation(property, source));
  };
}

export function openApi(): string {
  const components: Record<string, Schema> = {};
  const output = outputSchemas(components);
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const operations: Record<string, Schema> = {};
  const path = (kind: "command" | "query", names: readonly string[]): Schema => {
    const table = (kind === "command" ? commands : queries) as unknown as Record<string, { role: string; input: z.ZodType }>;
    const requests = names.map((name) => {
      const entry = table[name] as { role: string; input: z.ZodType };
      const key = `${name}.input`;
      const { $schema: _dialect, ...input } = z.toJSONSchema(entry.input, { io: "input", unrepresentable: "any" });
      components[key] = input;
      components[`${name}.output`] = output(kind === "command" ? "CommandOutputs" : "QueryOutputs", name);
      operations[name] = { kind, role: entry.role, input: { $ref: `${REF}${key}` }, output: { $ref: `${REF}${name}.output` } };
      return { title: name, type: "object", required: kind === "command" ? ["type", "input", "idempotencyKey"] : ["type", "input"], properties: { type: { const: name }, input: { $ref: `${REF}${key}` }, ...(kind === "command" ? { idempotencyKey: { type: "string" } } : {}) } };
    });
    return {
      post: {
        summary: kind === "command" ? "Do one thing" : "Read one thing",
        requestBody: { required: true, content: { "application/json": { schema: { oneOf: requests } } } },
        responses: {
          "200": { description: "The output of the named entry (x-brain-operations says which schema)", content: { "application/json": { schema: { type: "object", required: ["output"], properties: { output: { anyOf: names.map((name) => ({ $ref: `${REF}${name}.output` })) } } } } } },
          default: { description: "A refusal, with the matching HTTP status", content: { "application/json": { schema: { $ref: `${REF}Refusal` } } } },
        },
      },
    };
  };
  const paths = { "/v1/query": path("query", PUBLISHED.queries), "/v1/command": path("command", PUBLISHED.commands) };
  components["Refusal"] = { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, problems: { type: "array", items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } } } } } } };
  return `${JSON.stringify({
    openapi: "3.1.0",
    info: {
      title: "Brain API", version,
      description: "The commands and queries another system uses. Every request is a POST naming one entry in `type`; `x-brain-operations` gives each entry's input, output and the least role it needs. The file describes the commit it is in: it changes when Brain does.",
    },
    paths,
    "x-brain-operations": operations,
    components: { schemas: Object.fromEntries(Object.entries(components).sort(([a], [b]) => a.localeCompare(b))) },
  }, null, 2)}\n`;
}
