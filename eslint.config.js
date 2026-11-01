// SPDX-License-Identifier: GPL-2.0-or-later

import {defineConfig} from 'eslint/config';
import gnome from 'eslint-config-gnome';

export default defineConfig([
    gnome.configs.recommended,
    {
        ignores: ['node_modules'],
    },
]);
