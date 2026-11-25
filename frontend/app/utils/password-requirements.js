/**
 * What the API asks of a new password when resetting it (ResetPasswordRequest), checked
 * the way Laravel checks it: by Unicode category, so "é" is a letter and "한" is neither
 * upper nor lower case.
 *
 * The API also refuses passwords known from data breaches. Only it can tell, so that one
 * surfaces when the form is submitted.
 */
export const MIN_PASSWORD_LENGTH = 8;

const REQUIREMENTS = [
    { key: 'length', isMet: (password) => [...password].length >= MIN_PASSWORD_LENGTH },
    { key: 'mixed-case', isMet: (password) => /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password) },
    { key: 'number', isMet: (password) => /\p{N}/u.test(password) },
    { key: 'symbol', isMet: (password) => /[\p{Z}\p{S}\p{P}]/u.test(password) },
];

/**
 * Each requirement, in the order to show them, with whether the password meets it.
 *
 * @param {String} password
 * @return {Array<{key: String, isMet: Boolean}>}
 */
export default function passwordRequirements(password) {
    const value = String(password ?? '');

    return REQUIREMENTS.map(({ key, isMet }) => ({ key, isMet: isMet(value) }));
}
