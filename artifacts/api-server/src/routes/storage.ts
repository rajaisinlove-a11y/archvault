import { Router, type IRouter } from "express";
import { testIas3Connection } from "../storage-provider";

const storageRouter: IRouter = Router();

storageRouter.post("/storage/connection-test", async (_req, res) => {
  const result = await testIas3Connection();
  res.status(result.ok ? 200 : 503).json(result);
});

export default storageRouter;