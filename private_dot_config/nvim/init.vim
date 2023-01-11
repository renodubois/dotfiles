" Options
set exrc " executes vim directory in pwd if it exists
set relativenumber " relative line numbers
set nu " current line shows line number
set nohlsearch " no highlight on search so you don't have to type :noh every time
set hidden " buffers can go into the bg without being saved (!!)
set noerrorbells " ding ding ding
set tabstop=4 " 4 space tabs
set shiftwidth=4 " if using spaces, use 4 per tab
filetype plugin indent on " from old vimrc : indentation detection
set autoindent " Turn on autoindent
set nowrap " Disallow wrapping
set noswapfile " eff em
set nobackup " TODO: look this up
set undodir=~/.vim/undodir
set undofile " TODO: look this up (works w/ Undo Tree)
set incsearch " highlights as you search
set scrolloff=8 " Starts scrolling 8 lines below the bottom of the screen
set signcolumn=yes " Extra column for linting/errors, etc

" Plugins
call plug#begin('~/.vim/plugged')
Plug 'junegunn/fzf' " fuzzy file finder
Plug 'junegunn/fzf.vim' " fuzzy file finder
Plug 'neovim/nvim-lspconfig' " LSP config
Plug 'folke/lsp-colors.nvim' " LSP color stuff
Plug 'tpope/vim-fugitive' " Git wrapper 
Plug 'tpope/vim-eunuch' " UNIX Command sugar
Plug 'dracula/vim', { 'as': 'dracula' } " theme
Plug 'puremourning/vimspector' " debugging
Plug 'fatih/vim-go', { 'do': ':GoUpdateBinaries' } " Better Go support
Plug 'neoclide/coc.nvim', { 'branch': 'release' } " VS:Code-like autocomplete
Plug 'rust-lang/rust.vim' " Better Rust support
Plug 'rizzatti/dash.vim' " Searching Dash docs from Vim
Plug 'vim-airline/vim-airline' " cool statusbar
Plug 'kyazdani42/nvim-tree.lua' " file tree
Plug 'kyazdani42/nvim-web-devicons' " file tree (icons)
call plug#end()


" Bindings & Plugin Settings

" --- general
" Sets our <leader> to space
let mapleader = " "
" Deletes the current buffer, maintains windows/splits
nnoremap <silent> <leader>d :bp\|bd #<CR>

" --- fzf.vim
" Prevents filenames from being included in the ag/rg search
" From https://github.com/junegunn/fzf.vim/issues/346#issuecomment-288483704
command! -bang -nargs=* Ag call fzf#vim#ag(<q-args>, {'options': '--delimiter : --nth 4..'}, <bang>0)
nnoremap <C-P> :Files<CR>
nnoremap <leader>fs :Ag<Space>
nnoremap <leader>fb :Buffers<CR>

" --- vim-fugitive
nnoremap <leader>gs :Git status<CR>
nnoremap <leader>gc :Git commit<CR>
nnoremap <leader>gd :Git diff<CR>

" --- dash.vim
:nmap <silent> <leader>s <Plug>DashSearch
let g:dash_activate = 1 " should dash come to the foreground after searching in dash.vim?
" let g:dash_map = {} " lets you assign docsets to filetypes. For example,
" 'java' : 'android' would search all of the Android-related docsets when
" you're on a Java file

" --- vimspector
" see https://github.com/puremourning/vimspector#human-mode for binds
let g:vimspector_enable_mappings = 'HUMAN'
nnoremap <F3> :VimspectorReset<CR>

" --- coc.nvim
" Copied from their repo.
"
" Some servers have issues with backup files, see #649.
set nobackup
set nowritebackup

" Having longer updatetime (default is 4000 ms = 4 s) leads to noticeable
" delays and poor user experience.
set updatetime=300

" Always show the signcolumn, otherwise it would shift the text each time
" diagnostics appear/become resolved.
set signcolumn=yes

" Use tab for trigger completion with characters ahead and navigate.
" NOTE: Use command ':verbose imap <tab>' to make sure tab is not mapped by
" NOTE: There's always complete item selected by default, you may want to enable
" no select by `"suggest.noselect": true` in your configuration file.
" other plugin before putting this into your config.
inoremap <silent><expr> <TAB>
      \ coc#pum#visible() ? coc#pum#next(1):
      \ CheckBackspace() ? "\<Tab>" :
      \ coc#refresh()
inoremap <expr><S-TAB> coc#pum#visible() ? coc#pum#prev(1) : "\<C-h>"

" Make <CR> to accept selected completion item or notify coc.nvim to format
" <C-g>u breaks current undo, please make your own choice.
inoremap <silent><expr> <CR> coc#pum#visible() ? coc#pum#confirm()
                              \: "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"

function! CheckBackspace() abort
  let col = col('.') - 1
  return !col || getline('.')[col - 1]  =~# '\s'
endfunction

" Use <c-space> to trigger completion.
if has('nvim')
  inoremap <silent><expr> <c-space> coc#refresh()
else
  inoremap <silent><expr> <c-@> coc#refresh()
endif

" Use `[g` and `]g` to navigate diagnostics
" Use `:CocDiagnostics` to get all diagnostics of current buffer in location list.
nmap <silent> [g <Plug>(coc-diagnostic-prev)
nmap <silent> ]g <Plug>(coc-diagnostic-next)

" GoTo code navigation.
nmap <silent> gd <Plug>(coc-definition)
nmap <silent> gy <Plug>(coc-type-definition)
nmap <silent> gi <Plug>(coc-implementation)
nmap <silent> gr <Plug>(coc-references)

" Use K to show documentation in preview window.
nnoremap <silent> K :call ShowDocumentation()<CR>

function! ShowDocumentation()
  if CocAction('hasProvider', 'hover')
    call CocActionAsync('doHover')
  else
    call feedkeys('K', 'in')
  endif
endfunction

" Highlight the symbol and its references when holding the cursor.
autocmd CursorHold * silent call CocActionAsync('highlight')

" Symbol renaming.
nmap <leader>rn <Plug>(coc-rename)

" Formatting selected code.
xmap <leader>f  <Plug>(coc-format-selected)
nmap <leader>f  <Plug>(coc-format-selected)

augroup mygroup
  autocmd!
  " Setup formatexpr specified filetype(s).
  autocmd FileType typescript,json setl formatexpr=CocAction('formatSelected')
  " Update signature help on jump placeholder.
  autocmd User CocJumpPlaceholder call CocActionAsync('showSignatureHelp')
augroup end

" Applying codeAction to the selected region.
" Example: `<leader>aap` for current paragraph
xmap <leader>a  <Plug>(coc-codeaction-selected)
nmap <leader>a  <Plug>(coc-codeaction-selected)

" Remap keys for applying codeAction to the current buffer.
nmap <leader>ac  <Plug>(coc-codeaction)
" Apply AutoFix to problem on the current line.
nmap <leader>qf  <Plug>(coc-fix-current)

" Run the Code Lens action on the current line.
nmap <leader>cl  <Plug>(coc-codelens-action)

" Map function and class text objects
" NOTE: Requires 'textDocument.documentSymbol' support from the language server.
xmap if <Plug>(coc-funcobj-i)
omap if <Plug>(coc-funcobj-i)
xmap af <Plug>(coc-funcobj-a)
omap af <Plug>(coc-funcobj-a)
xmap ic <Plug>(coc-classobj-i)
omap ic <Plug>(coc-classobj-i)
xmap ac <Plug>(coc-classobj-a)
omap ac <Plug>(coc-classobj-a)

" Remap <C-f> and <C-b> for scroll float windows/popups.
if has('nvim-0.4.0') || has('patch-8.2.0750')
  nnoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? coc#float#scroll(1) : "\<C-f>"
  nnoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? coc#float#scroll(0) : "\<C-b>"
  inoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(1)\<cr>" : "\<Right>"
  inoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? "\<c-r>=coc#float#scroll(0)\<cr>" : "\<Left>"
  vnoremap <silent><nowait><expr> <C-f> coc#float#has_scroll() ? coc#float#scroll(1) : "\<C-f>"
  vnoremap <silent><nowait><expr> <C-b> coc#float#has_scroll() ? coc#float#scroll(0) : "\<C-b>"
endif

" Use CTRL-S for selections ranges.
" Requires 'textDocument/selectionRange' support of language server.
nmap <silent> <C-s> <Plug>(coc-range-select)
xmap <silent> <C-s> <Plug>(coc-range-select)

" Add `:Format` command to format current buffer.
command! -nargs=0 Format :call CocActionAsync('format')

" Add `:Fold` command to fold current buffer.
command! -nargs=? Fold :call     CocAction('fold', <f-args>)

" Add `:OR` command for organize imports of the current buffer.
command! -nargs=0 OR   :call     CocActionAsync('runCommand', 'editor.action.organizeImport')

" Add (Neo)Vim's native statusline support.
" NOTE: Please see `:h coc-status` for integrations with external plugins that
" provide custom statusline: lightline.vim, vim-airline.
" TODO(reno): integrate this w/ airline
" set statusline^=%{coc#status()}%{get(b:,'coc_current_function','')}

" TODO(reno): go through these and see if I actually need them
" Mappings for CoCList
" Show all diagnostics.
" nnoremap <silent><nowait> <space>a  :<C-u>CocList diagnostics<cr>
" " Manage extensions.
" nnoremap <silent><nowait> <space>e  :<C-u>CocList extensions<cr>
" " Show commands.
" nnoremap <silent><nowait> <space>c  :<C-u>CocList commands<cr>
" " Find symbol of current document.
" nnoremap <silent><nowait> <space>o  :<C-u>CocList outline<cr>
" " Search workspace symbols.
" nnoremap <silent><nowait> <space>s  :<C-u>CocList -I symbols<cr>
" " Do default action for next item.
" nnoremap <silent><nowait> <space>j  :<C-u>CocNext<CR>
" " Do default action for previous item.
" nnoremap <silent><nowait> <space>k  :<C-u>CocPrev<CR>
" " Resume latest coc list.
" nnoremap <silent><nowait> <space>p  :<C-u>CocListResume<CR>


" Commands
" File Tree
nnoremap <C-n> :NvimTreeToggle<CR>
nnoremap <leader>r :NvimTreeRefresh<CR>
nnoremap <leader>n :NvimTreeFindFile<CR>

" Debugging
let g:vdebug_options = { 'port':9001, 'path_maps': {'/vagrant/':getcwd()}, 'server': '' }

" fzf setup
set rtp+=/opt/homebrew/opt/fzf

" Taken from https://www.freecodecamp.org/news/how-to-search-project-wide-vim-ripgrep-ack/
" ack.vim --- {{{

" Use ripgrep for searching ⚡️
" Options include:
" --vimgrep -> Needed to parse the rg response properly for ack.vim
" --type-not sql -> Avoid huge sql file dumps as it slows down the search
" --smart-case -> Search case insensitive if all lowercase pattern, Search case sensitively otherwise
let g:ackprg = 'rg --vimgrep --type-not sql --smart-case'

" Auto close the Quickfix list after pressing '<enter>' on a list item
let g:ack_autoclose = 1

" Any empty ack search will search for the work the cursor is on
let g:ack_use_cword_for_empty_search = 1

" Don't jump to first match
cnoreabbrev Ack Ack!

" Maps <leader>/ so we're ready to type the search keyword
nnoremap <Leader>/ :Ack!<Space>
" }}}

" Navigate quickfix list with ease
nnoremap <silent> [q :cprevious<CR>
nnoremap <silent> ]q :cnext<CR>


" Lua-based Config
lua << EOF
-- LSP Config
local nvim_lsp = require('lspconfig')
local on_attach = function(client, bufnr)
  local function buf_set_keymap(...) vim.api.nvim_buf_set_keymap(bufnr, ...) end
  local function buf_set_option(...) vim.api.nvim_buf_set_option(bufnr, ...) end
  buf_set_option('omnifunc', 'v:lua.vim.lsp.omnifunc')
  -- Mappings.
  local opts = { noremap=true, silent=false }
  buf_set_keymap('n', 'gD', '<cmd>lua vim.lsp.buf.declaration()<CR>', opts)
  buf_set_keymap('n', 'gd', '<cmd>lua vim.lsp.buf.definition()<CR>', opts)
  buf_set_keymap('n', 'K', '<cmd>lua vim.lsp.buf.hover()<CR>', opts)
  buf_set_keymap('n', 'gi', '<cmd>lua vim.lsp.buf.implementation()<CR>', opts)
  buf_set_keymap('n', '<C-k>', '<cmd>lua vim.lsp.buf.signature_help()<CR>', opts)
  buf_set_keymap('n', '<space>wa', '<cmd>lua vim.lsp.buf.add_workspace_folder()<CR>', opts)
  buf_set_keymap('n', '<space>wr', '<cmd>lua vim.lsp.buf.remove_workspace_folder()<CR>', opts)
  buf_set_keymap('n', '<space>wl', '<cmd>lua print(vim.inspect(vim.lsp.buf.list_workspace_folders()))<CR>', opts)
  buf_set_keymap('n', '<space>D', '<cmd>lua vim.lsp.buf.type_definition()<CR>', opts)
  buf_set_keymap('n', '<space>rn', '<cmd>lua vim.lsp.buf.rename()<CR>', opts)
  buf_set_keymap('n', 'gr', '<cmd>lua vim.lsp.buf.references()<CR>', opts)
  buf_set_keymap('n', '<space>e', '<cmd>lua vim.lsp.diagnostic.show_line_diagnostics()<CR>', opts)
  buf_set_keymap('n', '[d', '<cmd>lua vim.lsp.diagnostic.goto_prev()<CR>', opts)
  buf_set_keymap('n', ']d', '<cmd>lua vim.lsp.diagnostic.goto_next()<CR>', opts)
  buf_set_keymap('n', '<space>q', '<cmd>lua vim.lsp.diagnostic.set_loclist()<CR>', opts)
end
require'lspconfig'.tsserver.setup{
	on_attach = on_attach
}
require'lspconfig'.jedi_language_server.setup{
	on_attach = on_attach
}
require'lspconfig'.phpactor.setup{
	root_dir = require'lspconfig'.util.root_pattern(".git"),
	on_attach = on_attach
}
require'lspconfig'.gopls.setup{
	cmd = {"gopls", "serve"},
	on_attach = on_attach,
	settings = {
		gopls = {
			analyses = {
				unusedparams = true
			},
			staticcheck = true
		}
	}
}
require'lspconfig'.rls.setup {
	on_attach = on_attach,
	settings = {
		rust = {
			unstable_features = false,
			build_on_save = false,
			all_features = true
		}
	}
}
require'lspconfig'.hls.setup {
	on_attach = on_attach
}
-- file tree setup
require('nvim-tree').setup()
EOF

" Treesitter-based folding
" set foldmethod=expr
" set foldexpr=nvim_treesitter#foldexpr()

" Enable Omnifunc for Go
autocmd FileType go setlocal omnifunc=v:lua.vim.lsp.omnifunc
autocmd FileType haskell setlocal shiftwidth=2 softtabstop=2 expandtab

" enable $theme 
set termguicolors
set winblend=0
set wildoptions=pum
set pumblend=5
syntax on 
