import _ from "lodash";

export const formatSuccessResponse = (entity: string, data: Record<string, any> | number | string) => {
	return {
		message : `${ entity } fetched`,
		data : {
			[_.toLower(entity)] : data
		}
	}
}

export const formatMutationResponse = (message: string, data?: {}) => {
	return {
		message : message,
		data : data ?? {}
	}
}

export const formatErrorResponse = (error: string) =>  ({
    error
})