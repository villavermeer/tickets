import BaseError from "./BaseError";

export default class ValidationError extends BaseError {
	constructor(message: string) {
		super({ status: 422, message })
	}
}