export interface ErrorInterface {
	status: number
	message: string
}

export default class BaseError extends Error {

	protected readonly data: ErrorInterface

	constructor(data: ErrorInterface) {
		super(data.message)
		this.data = data
		this.name = new.target.name
		Object.setPrototypeOf(this, new.target.prototype)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, new.target)
		}
	}

	public getStatusCode(): number {
		return this.data.status
	}

	public getMessage(): string {
		return this.data.message
	}
}
