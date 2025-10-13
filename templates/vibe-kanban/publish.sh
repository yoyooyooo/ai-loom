#!/bin/bash
set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# 检查必需的工具
check_prerequisites() {
    log_info "检查必需工具..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        log_error "npm 未安装"
        exit 1
    fi
    
    if ! command -v cargo &> /dev/null; then
        log_error "Rust/Cargo 未安装"
        exit 1
    fi
    
    if ! command -v git &> /dev/null; then
        log_error "Git 未安装"
        exit 1
    fi
    
    log_success "所有必需工具已安装"
}

# 检查 git 状态
check_git_status() {
    log_info "检查 Git 状态..."
    
    if [ -n "$(git status --porcelain)" ]; then
        log_warning "有未提交的更改"
        echo "当前未提交的文件："
        git status --short
        
        read -p "是否继续发布? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "发布已取消"
            exit 0
        fi
    fi
    
    log_success "Git 状态检查通过"
}

# 检查当前分支
check_branch() {
    local current_branch=$(git rev-parse --abbrev-ref HEAD)
    log_info "当前分支: $current_branch"
    
    if [ "$current_branch" != "main" ] && [ "$current_branch" != "master" ]; then
        log_warning "当前不在主分支上"
        
        read -p "是否继续发布? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "发布已取消"
            exit 0
        fi
    fi
}

# 运行测试和检查
run_tests() {
    log_info "运行测试和检查..."
    
    # 检查 Rust 代码
    log_info "检查 Rust 代码..."
    cargo check
    cargo test --workspace
    cargo clippy --all --all-targets --all-features -- -D warnings
    cargo fmt --all -- --check
    
    # 生成并检查 TypeScript 类型
    log_info "生成 TypeScript 类型..."
    npm run generate-types
    
    if ! npm run generate-types:check; then
        log_error "TypeScript 类型文件过期，请提交最新的 shared/types.ts"
        exit 1
    fi
    
    # 运行前端检查
    log_info "检查前端代码..."
    cd frontend && npm run check && cd ..
    
    log_success "所有测试和检查通过"
}

# 更新版本号
update_version() {
    log_info "更新版本号..."
    
    local current_version=$(node -p "require('./package.json').version")
    log_info "当前版本: $current_version"
    
    echo "选择版本更新类型:"
    echo "1) patch (0.0.x) - 修复版本"
    echo "2) minor (0.x.0) - 功能版本"
    echo "3) major (x.0.0) - 重大版本"
    echo "4) 手动输入版本号"
    echo "5) 跳过版本更新"
    
    read -p "请选择 (1-5): " -n 1 -r version_choice
    echo
    
    case $version_choice in
        1)
            npm version patch --no-git-tag-version
            ;;
        2)
            npm version minor --no-git-tag-version
            ;;
        3)
            npm version major --no-git-tag-version
            ;;
        4)
            read -p "请输入新版本号 (如 1.2.3): " new_version
            npm version $new_version --no-git-tag-version
            ;;
        5)
            log_info "跳过版本更新"
            ;;
        *)
            log_error "无效选择"
            exit 1
            ;;
    esac
    
    if [ "$version_choice" != "5" ]; then
        # 同步更新 npx-cli/package.json 的版本
        local new_version=$(node -p "require('./package.json').version")
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$new_version\"/" npx-cli/package.json
        log_success "版本号已更新到 $new_version"
    fi
}

# 构建项目
build_project() {
    log_info "构建项目..."
    
    # 构建前端
    log_info "构建前端..."
    cd frontend && npm run build && cd ..
    
    # 构建后端
    log_info "构建后端..."
    cargo build --release
    
    # 运行构建脚本
    log_info "创建分发包..."
    ./local-build.sh
    
    log_success "项目构建完成"
}

# 检查 npm 登录状态
check_npm_login() {
    log_info "检查 npm 登录状态..."
    
    if ! npm whoami &> /dev/null; then
        log_warning "未登录到 npm"
        read -p "是否现在登录? (Y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            npm login
        else
            log_error "需要登录 npm 才能发布"
            exit 1
        fi
    else
        local npm_user=$(npm whoami)
        log_success "已登录到 npm，用户: $npm_user"
    fi
}

# 检查包名可用性
check_package_availability() {
    log_info "检查包名可用性..."
    
    local main_package="vibe-starter"
    local cli_package="vibe-starter-cli"
    
    # 检查主包
    if npm info "$main_package" &> /dev/null; then
        local current_version=$(node -p "require('./package.json').version")
        local published_version=$(npm info "$main_package" version)
        
        if [ "$current_version" = "$published_version" ]; then
            log_error "版本 $current_version 已存在于 npm 上"
            log_info "请更新版本号后重试"
            exit 1
        else
            log_info "包 $main_package 存在，将发布新版本 $current_version"
        fi
    else
        log_info "包 $main_package 不存在，将作为新包发布"
    fi
    
    # 检查 CLI 包
    if npm info "$cli_package" &> /dev/null; then
        log_info "CLI 包 $cli_package 存在，将发布更新版本"
    else
        log_info "CLI 包 $cli_package 不存在，将作为新包发布"
    fi
}

# 发布到 npm
publish_to_npm() {
    log_info "发布到 npm..."
    
    # 发布主包
    log_info "发布主包..."
    npm publish
    
    # 发布 CLI 包
    log_info "发布 CLI 包..."
    cd npx-cli
    npm publish
    cd ..
    
    log_success "所有包已成功发布到 npm"
}

# 创建 Git 标签
create_git_tag() {
    local version=$(node -p "require('./package.json').version")
    local tag="v$version"
    
    log_info "创建 Git 标签: $tag"
    
    if git tag -l | grep -q "^$tag$"; then
        log_warning "标签 $tag 已存在"
        
        read -p "是否删除现有标签并重新创建? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git tag -d "$tag"
            git push origin --delete "$tag" 2>/dev/null || true
        else
            log_info "跳过标签创建"
            return
        fi
    fi
    
    git tag "$tag"
    git push origin "$tag"
    
    log_success "Git 标签 $tag 已创建并推送"
}

# 验证发布
verify_publish() {
    log_info "验证发布..."
    
    local package_name="vibe-starter-cli"
    local version=$(node -p "require('./package.json').version")
    
    # 等待一段时间让 npm 同步
    log_info "等待 npm 同步包信息..."
    sleep 10
    
    # 验证包信息
    if npm info "$package_name@$version" &> /dev/null; then
        log_success "包 $package_name@$version 已成功发布"
        
        # 提示用户如何使用
        echo
        log_success "🎉 发布成功!"
        echo
        echo "用户现在可以通过以下方式使用："
        echo "  npx $package_name"
        echo
        echo "或者安装后使用："
        echo "  npm install -g $package_name"
        echo "  vibe-starter"
        
    else
        log_warning "无法验证包发布状态，可能需要等待 npm 同步"
    fi
}

# 主函数
main() {
    echo "🚀 vibe-starter 发布脚本"
    echo "================================"
    echo
    
    check_prerequisites
    check_git_status
    check_branch
    run_tests
    update_version
    build_project
    check_npm_login
    check_package_availability
    
    echo
    log_warning "准备发布到 npm"
    read -p "确认发布? (Y/n): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        log_info "发布已取消"
        exit 0
    fi
    
    publish_to_npm
    create_git_tag
    verify_publish
    
    echo
    log_success "🎉 发布流程完成!"
}

# 捕获错误并清理
trap 'log_error "发布过程中出现错误"; exit 1' ERR

# 运行主函数
main "$@"
