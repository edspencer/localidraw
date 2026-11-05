// The contract's JSON schemas and its small validator (cli-contract's src/schema.ts), from the conformance runner this
// repo already has as a devDependency, for the tests ported from cli-contract.
// @ts-expect-error: the runner ships JavaScript without types
import * as schema from "@edspencer/cli-conformance/dist/src/schema.js";

export const loadSchema: (name: string) => object = schema.loadSchema;
export const validate: (schema: object, value: unknown) => string[] = schema.validate;
