local vim = vim
local Plug = vim.fn['plug#']

-- basic options
vim.o.hidden = true
vim.o.errorbells = false
vim.o.tabstop = 4
vim.o.shiftwidth = 4
vim.o.autoindent = true
vim.o.wrap = false
vim.o.swapfile = false
vim.o.undodir = '~/.vim/undodir'
vim.o.undofile = true
vim.o.incsearch = true
vim.o.scrolloff = 8
vim.o.signcolumn = 'yes'
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.relativenumber = true
vim.o.number = true
vim.o.hlsearch = false

vim.g.mapleader = ' '


-- Plugins via vim-plug
vim.call('plug#begin', '~/.vim/plugged')
Plug('williamboman/mason.nvim')                                       -- manages LSP/DAP/linters/formatters
Plug('williamboman/mason-lspconfig.nvim')                             -- uses mason to install lsp servers automatically
Plug('jay-babu/mason-nvim-dap.nvim')                                  -- uses mason to install dap programs
Plug('neovim/nvim-lspconfig')                                         -- lsp support
Plug('nvim-lua/plenary.nvim')                                         -- required for telescope.nvim
Plug('nvim-treesitter/nvim-treesitter', { ['do'] = ':TSUpdate' })     -- required for telescope.nvim
Plug('nvim-telescope/telescope.nvim', { ['tag'] = '0.1.5' })          -- searching/finder
Plug('nvim-telescope/telescope-fzf-native.nvim', { ['do'] = 'make' }) -- telescope extension
Plug('nvim-telescope/telescope-fzy-native.nvim')                      -- telescope extension
Plug('junegunn/fzf')                                                  -- fuzzy file finder
Plug('junegunn/fzf.vim')                                              -- fuzzy file finder
Plug('tpope/vim-fugitive')                                            -- Git wrapper
Plug('tpope/vim-eunuch')                                              -- UNIX Command sugar
Plug('ellisonleao/gruvbox.nvim')                                      -- theme
Plug('rizzatti/dash.vim')                                             -- Searching Dash docs from Vim
Plug('konapun/vacuumline.nvim')                                       -- statusbar
Plug('glepnir/galaxyline.nvim', { ['branch'] = 'main' })              -- statusbar
Plug('kyazdani42/nvim-tree.lua')                                      -- file tree
Plug('nvim-tree/nvim-web-devicons')                                   -- file tree (icons)
Plug('mfussenegger/nvim-dap')                                         -- debugging support (via DAP)
Plug('rcarriga/nvim-dap-ui')                                          -- UI for nvim-dap
Plug('kdheepak/lazygit.nvim')                                         -- lazygit inside of nvim
Plug('numToStr/Comment.nvim')                                         -- easy toggle comments
Plug('lewis6991/gitsigns.nvim')                                       -- modified/added/etc in the side column
Plug('hrsh7th/cmp-nvim-lsp')                                          -- Autocomplete
Plug('hrsh7th/cmp-buffer')                                            -- Autocomplete
Plug('hrsh7th/cmp-path')                                              -- Autocomplete
Plug('hrsh7th/cmp-cmdline')                                           -- Autocomplete
Plug('hrsh7th/nvim-cmp')                                              -- End autocomplete
Plug('mfussenegger/nvim-lint')                                        -- handles linters
Plug('folke/trouble.nvim')                                            -- diagnostic display
Plug('L3MON4D3/LuaSnip')                                              -- snippet engine
vim.call('plug#end')

require('Comment').setup()
require('gitsigns').setup()
require('vacuumline').setup()
require('nvim-tree').setup()

require('mason').setup()
require('mason-lspconfig').setup {
	automatic_installation = true -- automatically installs any lsp programs listed below
}
require('mason-nvim-dap').setup({
	automatic_installation = true -- automatically installs any dap programs listed below
})

-- lsp config
local lspconfig = require('lspconfig')
-- TODO(reno): Intelephense Pro Key
local servers = { 'lua_ls', 'tsserver', 'intelephense', 'rust_analyzer', 'gopls' }
local capabilities = require('cmp_nvim_lsp').default_capabilities()
for _, lsp in ipairs(servers) do
	lspconfig[lsp].setup {
		capabilities = capabilities
	}
end

local luasnip = require('luasnip')

-- autocomplete (via cmp) setup
-- copied from this document: https://github.com/neovim/nvim-lspconfig/wiki/Autocompletion
local cmp = require 'cmp'
cmp.setup {
	snippet = {
		expand = function(args)
			luasnip.lsp_expand(args.body)
		end
	},
	mapping = cmp.mapping.preset.insert({
		['<C-u>'] = cmp.mapping.scroll_docs(-4), -- Up
		['<C-d>'] = cmp.mapping.scroll_docs(4), -- Down
		-- C-b (back) C-f (forward) for snippet placeholder navigation.
		['<C-Space>'] = cmp.mapping.complete(),
		['<CR>'] = cmp.mapping.confirm {
			behavior = cmp.ConfirmBehavior.Replace,
			select = true,
		},
		['<Tab>'] = cmp.mapping(function(fallback)
			if cmp.visible() then
				cmp.select_next_item()
			elseif luasnip.expand_or_jumpable() then
				luasnip.expand_or_jump()
			else
				fallback()
			end
		end, { 'i', 's' }),
		['<S-Tab>'] = cmp.mapping(function(fallback)
			if cmp.visible() then
				cmp.select_prev_item()
			elseif luasnip.jumpable(-1) then
				luasnip.jump(-1)
			else
				fallback()
			end
		end, { 'i', 's' }),
	}),
	sources = {
		{ name = 'nvim_lsp' },
		{ name = 'luasnip' },
	},
}

-- default lsp keybinds: copied from gh:neovim/nvim-lspconfig, "Suggested Configuration"
-- See `:help vim.diagnostic.*` for documentation on any of the below functions
vim.keymap.set('n', '<leader>e', vim.diagnostic.open_float)
vim.keymap.set('n', '[d', vim.diagnostic.goto_prev)
vim.keymap.set('n', ']d', vim.diagnostic.goto_next)
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist)

-- Use LspAttach autocommand to only map the following keys
-- after the language server attaches to the current buffer
vim.api.nvim_create_autocmd('LspAttach', {
	group = vim.api.nvim_create_augroup('UserLspConfig', {}),
	callback = function(ev)
		-- Enable completion triggered by <c-x><c-o>
		vim.bo[ev.buf].omnifunc = 'v:lua.vim.lsp.omnifunc'

		-- Buffer local mappings.
		-- See `:help vim.lsp.*` for documentation on any of the below functions
		local opts = { buffer = ev.buf }
		vim.keymap.set('n', 'gD', vim.lsp.buf.declaration, opts)
		vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
		vim.keymap.set('n', 'K', vim.lsp.buf.hover, opts)
		vim.keymap.set('n', 'gi', vim.lsp.buf.implementation, opts)
		vim.keymap.set('n', '<C-k>', vim.lsp.buf.signature_help, opts)
		vim.keymap.set('n', '<leader>wa', vim.lsp.buf.add_workspace_folder, opts)
		vim.keymap.set('n', '<leader>wr', vim.lsp.buf.remove_workspace_folder, opts)
		vim.keymap.set('n', '<leader>wl', function()
			print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
		end, opts)
		vim.keymap.set('n', '<leader>D', vim.lsp.buf.type_definition, opts)
		vim.keymap.set('n', '<leader>rn', vim.lsp.buf.rename, opts)
		vim.keymap.set({ 'n', 'v' }, '<leader>ca', vim.lsp.buf.code_action, opts)
		vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
		vim.keymap.set('n', '<leader>f', function()
			vim.lsp.buf.format { async = true }
		end, opts)
	end,
})

-- telescope setup
local telescope = require('telescope')
telescope.setup {
	pickers = {
		find_files = {
			theme = "ivy"
		},
		git_files = {
			theme = "ivy"
		},
		live_grep = {
			theme = "ivy"
		},
		buffers = {
			theme = "ivy"
		},
		help_tags = {
			theme = "ivy"
		}
	},
	extensions = {
		fzf = {
			fuzzy = true,          -- false will only do exact matching
			override_generic_sorter = true, -- override the generic sorter
			override_file_sorter = true, -- override the file sorter
			case_mode = "smart_case"
		}
	}
}
telescope.load_extension('fzf')

local builtin = require('telescope.builtin')
vim.keymap.set('n', '<C-p>', builtin.find_files)
vim.keymap.set('n', '<leader>/', builtin.live_grep)
-- TODO(reno): Search for selection in visual mode, vimscript line below:
-- vnoremap <leader>/ y:Telescope grep_string search=<C-r>"<CR>
-- vim.keymap.set('n', '<C-p>', builtin.find_files)
vim.keymap.set('n', '<leader>fb', builtin.buffers)
vim.keymap.set('n', '<leader>fh', builtin.help_tags)
vim.keymap.set('n', '<leader>ff', builtin.resume)

-- dap/dap-ui setup (debugger)
local dap, dapui = require('dap'), require("dapui")
dap.adapters.php = {
	type = 'executable',
	command = 'node',
	args = { '/Users/reno/programs/vscode-php-debug/out/phpDebug.js' }
}
-- This is specific to my LACRM setup
-- TODO: File mapping to Vagrant machine
dap.configurations.php = {
	{
		type = 'php',
		request = 'launch',
		name = 'Listen for Xdebug',
		port = 9001,
		pathMappings = {
			["/vagrant/"] = "/Users/reno/lacrm/LessAnnoyingCRM"
		}
	}
}

dap.adapters["pwa-node"] = {
	type = "server",
	host = "localhost",
	port = "${port}",
	executable = {
		command = "node",
		args = { "/Users/reno/programs/js-debug/src/dapDebugServer.js", "${port}" }
	}
}

dap.configurations.javascript = {
	{
		type = "pwa-node",
		request = "launch",
		name = "Launch file",
		program = "${file}",
		cwd = "${workspaceFolder}"
	}
}


dapui.setup {}
dap.listeners.after.event_initialized["dapui_config"] = function()
	dapui.open()
end
dap.listeners.before.disconnect["dapui_config"] = function()
	dapui.close()
end
dap.listeners.after.event_exited["dapui_config"] = function()
	dapui.close()
end

vim.keymap.set('n', '<F5>', function() dap.continue() end)
vim.keymap.set('n', '<leader>dd', function() dap.disconnect() end)
vim.keymap.set('n', '<F10>', function() dap.step_over() end)
vim.keymap.set('n', '<F11>', function() dap.step_into() end)
vim.keymap.set('n', '<F12>', function() dap.step_out() end)
vim.keymap.set('n', '<leader>b', function() dap.toggle_breakpoint() end)
vim.keymap.set('n', '<leader>B', function() dap.set_breakpoint() end)
vim.keymap.set('n', '<leader>lp', function() dap.set_breakpoint(nil, nil, vim.fn.input('Log point message: ')) end)
vim.keymap.set('n', '<leader>dr', function() dap.repl.open() end)
vim.keymap.set('n', '<leader>dl', function() dap.run_last() end)
vim.keymap.set({ 'n', 'v' }, '<Leader>dh', function()
	require('dap.ui.widgets').hover()
end)
vim.keymap.set({ 'n', 'v' }, '<Leader>dp', function()
	require('dap.ui.widgets').preview()
end)
vim.keymap.set('n', '<Leader>df', function()
	local widgets = require('dap.ui.widgets')
	widgets.centered_float(widgets.frames)
end)
vim.keymap.set('n', '<Leader>ds', function()
	local widgets = require('dap.ui.widgets')
	widgets.centered_float(widgets.scopes)
end)

-- trouble.nvim binds
vim.keymap.set("n", "<leader>xx", function() require("trouble").toggle() end)
vim.keymap.set("n", "<leader>xw", function() require("trouble").toggle("workspace_diagnostics") end)
vim.keymap.set("n", "<leader>xd", function() require("trouble").toggle("document_diagnostics") end)
vim.keymap.set("n", "<leader>xq", function() require("trouble").toggle("quickfix") end)
vim.keymap.set("n", "<leader>xl", function() require("trouble").toggle("loclist") end)
vim.keymap.set("n", "gR", function() require("trouble").toggle("lsp_references") end)

--- custom keybinds
-- TODO(reno): audit use of cmd instead of the lua functions -- is one approach better? does it matter?
vim.keymap.set('n', '<leader>lg', '<cmd>LazyGit<cr>')
vim.keymap.set('n', '<C-n>', '<cmd>NvimTreeToggle<cr>')
-- quickly add a todo comment
vim.keymap.set('n', '<leader>td', 'gccaTODO(reno):')

-- Set color scheme
vim.cmd.colorscheme('gruvbox')
