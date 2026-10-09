import { Router } from 'express';
import { z } from 'zod';
import { requireOperator } from '../api/operator-auth.js';
import { prisma } from '../../db/prisma.js';
import { ListInput, PreviewInput, ApplyInput, ReviewError } from './contracts.js';
import { listCases, reviewSummary } from './cases.js';
import { inspectCase, candidateSearch } from './inspection.js';
import { planCorrection, publicPreview } from './planner.js';
import { applyCorrection, actionStatus, undoAction } from './actions.js';

export const reviewRouter = Router();
reviewRouter.use(requireOperator);
reviewRouter.use((_req,res,next) => { res.set('Cache-Control','no-store');next(); });
const route = (fn) => async (req,res,next) => {
  try { await fn(req,res); }
  catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request',message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0,5).join('; ') });
    if (err instanceof ReviewError) return res.status(err.status).json({ error: err.code,message: err.message });
    next(err);
  }
};
reviewRouter.get('/summary',route(async (_req,res) => res.json(await reviewSummary())));
reviewRouter.get('/',route(async (req,res) => res.json(await listCases(ListInput.parse(req.query)))));
reviewRouter.get('/:id',route(async (req,res) => res.json(await inspectCase(req.params.id))));
reviewRouter.get('/:id/candidates',route(async (req,res) => {
  const q = z.object({ q: z.string().max(200).default(''),offset: z.coerce.number().int().min(0).default(0),limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
  res.json(await candidateSearch(req.params.id,q));
}));
reviewRouter.post('/:id/preview',route(async (req,res) => res.json(publicPreview(await planCorrection(req.params.id,PreviewInput.parse(req.body),prisma)))));
reviewRouter.post('/:id/actions',route(async (req,res) => res.json(await applyCorrection(req.params.id,ApplyInput.parse(req.body),req.operator))));
reviewRouter.get('/:id/actions/:actionId',route(async (req,res) => res.json(await actionStatus(req.params.id,req.params.actionId))));
reviewRouter.post('/:id/actions/:actionId/undo',route(async (req,res) => {
  const body = z.object({ apply: z.boolean().default(false),fingerprint: z.string().length(64).optional() }).strict().parse(req.body ?? {});
  res.json(await undoAction(req.params.id,req.params.actionId,body,{ operator: req.operator }));
}));
reviewRouter.get('/:id/fixtures',route(async (req,res) => {
  const { exportReviewFixture } = await import('./fixtures.js');
  res.json(await exportReviewFixture(req.params.id,prisma));
}));
