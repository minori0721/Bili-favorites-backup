import { Router } from 'express';
import type { createUpSubscriptionService } from '../up-subscriptions/service.js';
import type { RouteBoundary } from './route-boundary.js';
export function createUpSubscriptionRouter(deps:{service:ReturnType<typeof createUpSubscriptionService>;boundary:RouteBoundary}) {
  const router=Router(),service=deps.service;
  router.get('/api/up-discovery/:kind',deps.boundary(async(req,res)=>{res.json({success:true,data:await service.discover(req.params.kind,req.query)});}));
  router.get('/api/up-subscriptions',deps.boundary((_req,res)=>{res.json({success:true,data:service.list()});}));
  router.get('/api/up-subscriptions/:id',deps.boundary((req,res)=>{res.json({success:true,data:service.get(req.params.id)});}));
  router.post('/api/up-subscriptions',deps.boundary(async(req,res)=>{res.json({success:true,data:await service.create(req.body)});}));
  router.patch('/api/up-subscriptions/:id',deps.boundary(async(req,res)=>{res.json({success:true,data:await service.update(req.params.id,req.body)});}));
  router.delete('/api/up-subscriptions/:id',deps.boundary((req,res)=>{res.json({success:true,data:service.remove(req.params.id,req.body)});}));
  router.post('/api/up-subscriptions/:id/removal-preview',deps.boundary((req,res)=>{res.json({success:true,data:service.previewRemoval(req.params.id,req.body)});}));
  router.get('/api/up-subscriptions/:id/items',deps.boundary((req,res)=>{res.json({success:true,data:service.catalog(req.params.id,req.query)});}));
  router.post('/api/up-subscriptions/:id/selection',deps.boundary((req,res)=>{res.json({success:true,data:service.select(req.params.id,req.body)});}));
  router.post('/api/up-subscriptions/:id/scan',deps.boundary((req,res)=>{res.json({success:true,data:service.scan(req.params.id)});}));
  router.post('/api/up-subscriptions/:id/items/:bv/action-preview',deps.boundary((req,res)=>{res.json({success:true,data:service.previewAction(req.params.id,req.params.bv,req.body)});}));
  router.post('/api/up-subscriptions/:id/items/:bv/actions',deps.boundary((req,res)=>{res.json({success:true,data:service.action(req.params.id,req.params.bv,req.body)});}));
  router.post('/api/up-subscriptions/:id/items/:bv/unblock',deps.boundary((req,res)=>{res.json({success:true,data:service.unblock(req.params.id,req.params.bv,req.body)});}));
  router.get('/api/up-subscriptions/operations/:id',deps.boundary((req,res)=>{res.json({success:true,data:service.operation(req.params.id)});}));
  router.post('/api/up-subscriptions/operations/:id/retry',deps.boundary((req,res)=>{res.json({success:true,data:service.retry(req.params.id)});}));
  router.post('/api/up-subscriptions/operations/:id/removal-retry',deps.boundary((req,res)=>{res.json({success:true,data:service.retryRemoval(req.params.id)});}));
  router.post('/api/up-subscriptions/operations/:id/removal-repreview',deps.boundary((req,res)=>{res.json({success:true,data:service.repreviewRemoval(req.params.id)});}));
  return router;
}
