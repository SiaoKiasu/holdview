import { z } from "zod";
// null disables monitoring; explicit zero still monitors positions and income.
export const netTransferSchema = z
  .string()
  .regex(/^-?\d{1,20}(\.\d{1,16})?$/)
  .nullable();
export const futuresWriteSchema = z
  .object({
    revision: z.string().uuid().nullable(),
    netTransfer: netTransferSchema,
  })
  .strict();
export type FuturesSettings = {
  revision: string | null;
  netTransfer: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
};
