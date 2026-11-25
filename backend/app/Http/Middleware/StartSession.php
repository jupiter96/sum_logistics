<?php

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession as BaseStartSession;
use Illuminate\Session\NullSessionHandler;
use Symfony\Component\HttpFoundation\Response;

/**
 * Starts the session without storing it for API clients that never come back to it.
 *
 * Every API route starts a session, because core-api keeps the current company and user in
 * it while a request runs. A client that authenticates each request with a token and sends
 * no session cookie gets a new session every time, so storing it only leaves files (or Redis
 * keys) nobody reads - and with the file driver, 2 in 100 requests stop to scan them all.
 *
 * The console sends its session cookie back, and keeps its session: impersonation relies
 * on it.
 */
class StartSession extends BaseStartSession
{
    public function handle($request, \Closure $next)
    {
        if (!$this->isStateless($request)) {
            return parent::handle($request, $next);
        }

        $session = $this->manager->driver();
        $handler = $session->getHandler();

        $session->setHandler(new NullSessionHandler());
        $request->attributes->set('stateless_session', true);

        // The session store is shared by the worker's requests.
        try {
            return parent::handle($request, $next);
        } finally {
            $session->setHandler($handler);
        }
    }

    /**
     * Public API routes only: the console's internal routes may start a session that a
     * later request relies on.
     */
    protected function isStateless(Request $request): bool
    {
        return (bool) config('performance.stateless_api_sessions')
            && !$request->is('int/*', '*/int/*')
            && $request->is('v1/*', '*/v1/*')
            && ($request->bearerToken() !== null || $request->getUser() !== null)
            && !$request->cookies->has((string) config('session.cookie'));
    }

    /**
     * Without a stored session there is nothing for the cookie to point to.
     */
    protected function addCookieToResponse(Response $response, \Illuminate\Contracts\Session\Session $session)
    {
        if (!request()->attributes->get('stateless_session')) {
            parent::addCookieToResponse($response, $session);
        }
    }
}
