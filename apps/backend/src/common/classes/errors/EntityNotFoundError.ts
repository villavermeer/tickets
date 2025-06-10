import BaseError from "./BaseError";

export default class EntityNotFoundError extends BaseError {
	constructor(entity: string) {
		super({ status: 404, message: entity + ' not found' });
	}
}