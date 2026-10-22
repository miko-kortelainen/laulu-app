import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

dotenv.config();
dotenv.config({ path: new URL('../.env', import.meta.url) });

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    integrations: [
      // The shared error response helper reports unexpected errors, including handled ones.
      Sentry.expressIntegration({ shouldHandleError: false }),
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,
    profileSessionSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb: (breadcrumb) => breadcrumb.category === 'console' ? null : breadcrumb,
  });
}
