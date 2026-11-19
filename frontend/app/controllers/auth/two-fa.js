import Controller from '@ember/controller';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { inject as service } from '@ember/service';

/**
 * Number of digits in a sent or authenticator app code.
 *
 * @type {Number}
 */
export const OTP_LENGTH = 6;

/**
 * The digits of a typed or pasted code: SMS apps and password managers often paste
 * "123 456" or "123-456".
 *
 * @param {*} value
 * @return {String}
 */
export function normalizeOtp(value) {
    return String(value ?? '').replace(/\D/g, '');
}

/**
 * Controller responsible for handling two-factor authentication.
 * @class AuthTwoFaController
 * @extends Controller
 */
export default class AuthTwoFaController extends Controller {
    /**
     * Router service.
     *
     * @var {Service}
     */
    @service router;

    /**
     * Fetch service for making HTTP requests.
     *
     * @var {Service}
     */
    @service fetch;

    /**
     * Notifications service for handling notifications.
     *
     * @var {Service}
     */
    @service notifications;

    /**
     * Session service for managing user sessions.
     *
     * @var {Service}
     */
    @service session;

    /**
     * Internationalization service.
     *
     * @var {Service}
     */
    @service intl;

    /**
     * Tracked property for storing the verification token.
     *
     * @property {string} token
     * @tracked
     */
    @tracked token;

    /**
     * The current 2FA identity in memory
     * @property {string} identity
     * @tracked
     */
    @tracked identity;

    /**
     * Tracked property representing the client token from the validated 2fa session.
     *
     * @property {number} clientToken
     * @tracked
     * @default null
     */
    @tracked clientToken;

    /**
     * Tracked property for storing the verification code.
     *
     * @property {string} verificationCode
     * @tracked
     */
    @tracked verificationCode = '';

    /**
     * Tracked property for storing the verification code.
     *
     * @property {string} verificationCode
     * @tracked
     */
    @tracked otpValue = '';

    /**
     * Tracked property representing the date the 2fa session will expire
     * @property {Date|null} twoFactorSessionExpiresAfter
     * @tracked
     * @default null
     */
    @tracked twoFactorSessionExpiresAfter;

    /**
     * Tracked property representing when the countdown is ready to start.
     *
     * @property {Boolean} countdownReady
     * @tracked
     * @default false
     */
    @tracked countdownReady = false;

    /**
     * Tracked property representing when verification code has expired.
     *
     * @property {Boolean} isCodeExpired
     * @tracked
     * @default false
     */
    @tracked isCodeExpired = false;

    /**
     * How the code is provided: `authenticator_app`, or the method a code was sent with.
     *
     * @property {string} method
     * @tracked
     */
    @tracked method;

    /**
     * Whether the user is entering one of their recovery codes instead.
     *
     * @property {Boolean} useRecoveryCode
     * @tracked
     * @default false
     */
    @tracked useRecoveryCode = false;

    /**
     * Whether a code is being checked. A second check while one is in flight would hit a
     * session the first one already closed, and every wrong check uses up an attempt.
     *
     * @property {Boolean} isVerifying
     * @tracked
     * @default false
     */
    @tracked isVerifying = false;

    /**
     * Query parameters for the controller.
     *
     * @property {Array} queryParams
     */
    queryParams = ['token', 'clientToken'];

    /**
     * Whether the code comes from the user's authenticator app.
     *
     * @property {Boolean} isAuthenticatorApp
     */
    get isAuthenticatorApp() {
        return this.method === 'authenticator_app';
    }

    /**
     * Switch between the authenticator app code and a recovery code.
     *
     * @method toggleRecoveryCode
     * @action
     */
    @action toggleRecoveryCode(event) {
        event?.preventDefault?.();
        this.useRecoveryCode = !this.useRecoveryCode;
        this.verificationCode = '';
    }

    /**
     * Action method for verifying the entered verification code.
     *
     * @method verifyCode
     * @action
     */
    @action async verifyCode(event) {
        // prevent form default behaviour
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        if (this.isVerifying) {
            return;
        }

        const { token, clientToken, identity } = this;

        if (!clientToken) {
            this.notifications.error(this.intl.t('auth.two-fa.verify-code.invalid-session-error-notification'));
            return;
        }

        // A recovery code is sent as typed; a sent or app code is its 6 digits. An incomplete
        // code is not sent at all: the server would count it as a wrong attempt.
        const code = this.useRecoveryCode ? String(this.verificationCode ?? '').trim() : normalizeOtp(this.verificationCode);
        if (!code || (!this.useRecoveryCode && code.length !== OTP_LENGTH)) {
            this.notifications.warning(this.intl.t('auth.two-fa.verify-code.enter-code-notification', { length: OTP_LENGTH }));
            return;
        }

        this.isVerifying = true;
        try {
            // Call the backend API to verify the entered verification code
            const { authToken } = await this.fetch.post('two-fa/verify', {
                token,
                code,
                clientToken,
                identity,
            });

            // If verification is successful, transition to the desired route
            this.notifications.success(this.intl.t('auth.two-fa.verify-code.verification-successful-notification'));

            // authenticate user; the code stays "being checked" until the session exists
            await this.session.authenticate('authenticator:sum_logistics', { authToken, identity });
            return this.router.transitionTo('console');
        } catch (error) {
            if (error?.message?.includes('Verification code has expired')) {
                this.notifications.info(this.intl.t('auth.two-fa.verify-code.verification-code-expired-notification'));
            } else if (error?.message?.includes('Too many failed verification attempts')) {
                // The server has ended this 2FA session; only a fresh sign-in starts another.
                this.notifications.error(this.intl.t('auth.two-fa.verify-code.too-many-attempts-notification'));
                return this.router.transitionTo('auth.login');
            } else {
                this.notifications.error(this.intl.t('auth.two-fa.verify-code.verification-code-failed-notification'));
            }
        } finally {
            this.isVerifying = false;
        }
    }

    /**
     * Resends the verification code for Two-Factor Authentication.
     * Disables the countdown timer while processing and handles success or error notifications.
     *
     * @returns {Promise<void>}
     * @action
     */
    @action async resendCode(event) {
        event?.preventDefault?.();

        // disable countdown timer
        this.countdownReady = false;

        try {
            const { identity, token } = this;
            const { clientToken, method } = await this.fetch.post('two-fa/resend', {
                identity,
                token,
            });

            if (clientToken) {
                // An authenticator app user asking for a code gets one by email or SMS
                this.method = method;
                this.useRecoveryCode = false;
                this.clientToken = clientToken;
                this.session.store.persist({ identity, token, clientToken, method });
                this.twoFactorSessionExpiresAfter = this.getExpirationDateFromClientToken(clientToken);
                // Without a readable expiry the countdown would end at once and call a
                // valid code expired, so it only runs when there is one.
                this.countdownReady = this.twoFactorSessionExpiresAfter !== null;
                this.isCodeExpired = false;
                this.notifications.success(this.intl.t('auth.two-fa.resend-code.verification-code-resent-notification'));
            } else {
                this.notifications.error(this.intl.t('auth.two-fa.resend-code.verification-code-resent-error-notification'));
            }
        } catch (error) {
            // Handle errors, show error notifications, etc.
            this.notifications.error(this.intl.t('auth.two-fa.resend-code.verification-code-resent-error-notification'));
        }
    }

    /**
     * Cancels the current Two-Fa session and redirects to login screen.
     *
     * @returns {Promise<Transition>}
     * @memberof AuthTwoFaController
     */
    @action cancelTwoFactor() {
        return this.fetch
            .post('two-fa/invalidate', {
                identity: this.identity,
                token: this.token,
            })
            .then(() => {
                return this.router.transitionTo('auth.login');
            });
    }

    /**
     * Set that the verification code has expired and allow user to resend.
     *
     * @memberof AuthTwoFaController
     */
    @action handleCodeExpired() {
        this.isCodeExpired = true;
        this.countdownReady = false;
    }

    /**
     * Handles the input of the OTP (One-Time Password) and triggers the verification process.
     *
     * @param {string} otpValue - The OTP value entered by the user.
     * @returns {void}
     * @action
     */
    @action handleOtpInput(otpValue) {
        this.verificationCode = otpValue;
        this.verifyCode();
    }

    /**
     * Keeps the code in step with every keystroke, so the Verify button submits what is in
     * the field. A pasted code with a separator ("123 456") is longer than the field's
     * 6 characters and never completes it, so it is checked here once it has 6 digits.
     *
     * @param {string} otpValue - The current value of the OTP field.
     * @returns {void}
     * @action
     */
    @action updateOtp(otpValue) {
        this.verificationCode = otpValue;

        const value = String(otpValue ?? '');
        if (value.length !== OTP_LENGTH && normalizeOtp(value).length === OTP_LENGTH) {
            this.verifyCode();
        }
    }

    /**
     * Converts a base64 encoded client token to a Date representing the expiration date.
     *
     * @method getExpirationDateFromClientToken
     * @param {string} clientToken - Base64 encoded client token.
     * @returns {Date|null} - Date representing the expiration date, or null if invalid.
     */
    getExpirationDateFromClientToken(clientToken) {
        if (!clientToken || typeof clientToken !== 'string') {
            return null;
        }

        const decoder = new TextDecoder();
        let binString;
        try {
            binString = atob(clientToken);
        } catch {
            return null;
        }
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
        const decodedString = decoder.decode(bytes);

        if (typeof decodedString === 'string' && decodedString.includes('|')) {
            const parts = decodedString.split('|');
            const expiresAt = this.convertUtcToClientTime(parts[0]);

            // convertUtcToClientTime always hands back a Date, so an `instanceof Date`
            // check could never fail: an unparseable stamp produced an Invalid Date that
            // reached twoFactorSessionExpiresAfter and rendered the countdown as NaN.
            // Only a usable date is an expiry; anything else falls through to null.
            if (!Number.isNaN(expiresAt.getTime())) {
                return expiresAt;
            }
        }

        return null;
    }

    /**
     * Reads the expiry the server put in a client token as the moment it names.
     *
     * The server writes it in UTC without a zone ("2026-11-19 10:00:00", Carbon's default
     * format). Browsers disagree on such a string: Chrome reads it as local time, Safari
     * returns an Invalid Date, which ended the countdown at once and called a valid code
     * expired. It is parsed as UTC here instead. A stamp that names its zone ("…Z",
     * "+09:00") is read as written.
     *
     * @method convertUtcToClientTime
     * @param {string} utcDateTimeString - UTC date-time string.
     * @returns {Date} - The moment, or an Invalid Date when the stamp cannot be read.
     */
    convertUtcToClientTime(utcDateTimeString) {
        const value = String(utcDateTimeString ?? '').trim();
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);

        if (match) {
            const [, year, month, day, hours, minutes, seconds = '0', fraction = '0'] = match;
            const milliseconds = Math.round(Number(`0.${fraction}`) * 1000);
            return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), milliseconds));
        }

        return new Date(value);
    }
}
