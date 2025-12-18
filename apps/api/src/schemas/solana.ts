import { z } from "zod";
import { zCsvString } from "./common.js";

export const solanaMintsQuerySchema = z.object({
  ids: zCsvString("ids is required").refine((ids) => ids.length <= 50, {
    message: "ids must contain 50 or fewer mints",
  }),
});
