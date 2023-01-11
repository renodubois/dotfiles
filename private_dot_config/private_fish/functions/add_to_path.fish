function add_to_path --description 'Prepend to PATH'
	set --universal fish_user_paths $fish_user_paths $argv
end
