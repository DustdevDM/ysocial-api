import { z } from "zod";

const label = (max: number) =>
  z.string().trim().min(1).max(max).refine((value) => !value.includes("\u0000"));

export const pollDefinitionSchema = z.strictObject({
  title: label(120),
  options: z.array(label(80)).min(2).max(6).refine(
    (options) => new Set(options.map((option) => option.toLowerCase())).size === options.length,
  ),
  anonymous: z.boolean().default(false),
  allowRevote: z.boolean().optional(),
}).transform(({ title, options, anonymous }) => ({ title, options, anonymous }));

export type PollDefinition = z.output<typeof pollDefinitionSchema>;
