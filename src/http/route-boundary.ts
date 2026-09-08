import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** The application supplies this boundary so maintenance admission stays centralized. */
export type RouteBoundary = (handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) => RequestHandler;
