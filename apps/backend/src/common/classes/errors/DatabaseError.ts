import BaseError from "./BaseError";

export default class DatabaseError extends BaseError {
	constructor(message: string) {
		super({ status: 500, message });
	}
}