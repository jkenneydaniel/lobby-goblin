// Compatibility facade for existing management coordinators and callers.
export {OperationFailure as ManagementFailure, operationReason as managementDiagnostic} from './operation-errors.js';
import {operationDiagnostic} from './operation-errors.js';
export const managementFailure = error => operationDiagnostic(error, {fallback: 'management-update-failed'});
