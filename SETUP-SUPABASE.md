# Supabase 云同步设置

只需设置一次。完成后，Safari、主屏幕快捷方式和其他设备会使用同一份云端书架。

## 1. 创建免费项目

1. 登录 https://supabase.com/dashboard 并创建项目。
2. 打开 **SQL Editor**，新建查询。
3. 复制项目中的 `supabase-schema.sql` 全部内容并执行。

## 2. 创建你的个人账号

1. 打开 **Authentication → Users**。
2. 点击 **Add user → Create new user**。
3. 输入自己的邮箱和强密码，并自动确认邮箱。

网站没有注册入口，只有在这里创建的账号才能登录。

## 3. 填写网站配置

1. 打开 **Project Settings → API**。
2. 找到 Project URL 和 publishable/anon key。
3. 打开项目的 `config.js`，填入：

```js
window.AO3_CLOUD_CONFIG = {
  supabaseUrl: '你的 Project URL',
  supabaseAnonKey: '你的 publishable 或 anon key',
};
```

anon/publishable key 本来就是网页可见的公开密钥。`supabase-schema.sql` 中的 RLS 策略保证登录用户只能访问自己的数据。不要把 service_role key 写入网页。

## 4. 配置密码恢复网址

1. 先把网站部署到可公开访问的 HTTPS 地址。
2. 打开 **Authentication → URL Configuration**。
3. 将 **Site URL** 设置为网站首页地址，例如 `https://你的域名/项目路径/`。
4. 在 **Redirect URLs** 中添加同一个首页地址。

密码恢复邮件会跳回这个地址。不要填写 `file:///...` 本地文件路径或默认的 `localhost:3000`。

## 5. 重新部署并首次迁移

重新部署后，在原本保存有记录的 Safari 中先登录一次。网站会把现有本地记录自动上传到 Supabase。确认顶部显示“已同步”后，再在主屏幕快捷方式和其他设备中登录。

建议迁移完成后立即导出一次 JSON 备份。
