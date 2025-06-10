import BaseError from "./BaseError";

export default class UnauthorizedError extends BaseError {
	constructor() {
		super({ status: 403, message: 'Unauthorized' })
	}
}