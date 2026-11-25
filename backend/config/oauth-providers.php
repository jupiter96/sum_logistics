<?php

use App\Auth\OAuth\Drivers\FacebookDriver;

/*
|--------------------------------------------------------------------------
| Additional sign-in providers
|--------------------------------------------------------------------------
|
| Providers this application adds to the ones core-api ships (Google,
| Microsoft, GitHub and Apple). AppServiceProvider merges them into
| oauth.providers; a provider core-api defines under the same id wins.
|
| As with core-api's own, what an administrator saves in the console under
| Admin > Auth Config takes precedence over these environment values.
|
*/

return [
    'facebook' => [
        'driver'        => FacebookDriver::class,
        'enabled'       => env('OAUTH_FACEBOOK_ENABLED', false),
        'client_id'     => env('OAUTH_FACEBOOK_CLIENT_ID'),
        'client_secret' => env('OAUTH_FACEBOOK_CLIENT_SECRET'),
    ],
];
