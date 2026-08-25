import { AuthError } from '../../../../../src/auth/auth';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  directoryPickerRequestSchema,
  directoryPickerResultSchema,
} from '../../../../../src/http/contracts';
import {
  DirectoryPickerError,
  isLocalDirectoryPickerAvailable,
  selectLocalDirectory,
} from '../../../../../src/local-system/directory-picker';

export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => {
        const identity = requireApiAuthentication(request);
        if (identity.kind !== 'session') {
          throw new AuthError(
            'browser_session_required',
            'A browser session is required to open the folder picker.',
            403,
          );
        }
        if (!isLocalDirectoryPickerAvailable()) {
          throw new DirectoryPickerError(
            'directory_picker_unavailable',
            'The macOS folder picker is unavailable in this environment.',
            404,
          );
        }
      },
      body: directoryPickerRequestSchema,
      output: directoryPickerResultSchema,
    },
    () => selectLocalDirectory(),
  );
}
