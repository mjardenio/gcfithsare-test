# GC FitShare

A student wellness social platform designed for Gordon College students to connect, share wellness content, and access guidance counselling services.

## 🌟 Features

### Core Features
- **Reddit-style Feed**: Browse posts with hot/new/top/controversial filtering and category-based discovery
- **Profile System**: Discord-inspired profile layout with customizable bio, wellness stats, and lifestyle setup
- **Post Interactions**: Like, comment, bookmark, and share posts with nested comment threads
- **Expert Verification**: Verified experts can endorse posts and provide authoritative wellness content
- **Guidance Counselling**: Book appointments with guidance counsellors and view availability
- **Admin Dashboard**: Moderation tools for post approval, user management, and platform oversight

### Wellness Categories
- 🥗 **Nutrition**: Healthy eating tips, meal plans, and nutritional advice
- 💪 **Fitness**: Workout routines, exercise tips, and fitness goals
- 🧠 **Mental Wellness**: Mental health resources, stress management, and mindfulness
- 📚 **Productivity**: Study tips, time management, and academic success strategies

### Additional Features
- **Dark Mode**: Toggle between light and dark themes
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Real-time Notifications**: Stay updated with post interactions and system alerts
- **Search Functionality**: Find users and content quickly
- **Image Uploads**: Share wellness journey through images
- **Lifestyle Quiz**: Personalized content recommendations based on wellness preferences

## 🛠 Tech Stack

### Frontend
- **HTML5**: Semantic markup and structure
- **CSS3**: Modern styling with CSS Grid, Flexbox, and custom properties
- **JavaScript (ES6+)**: Client-side logic and interactions
- **Supabase JS Client**: Authentication and database interactions

### Backend
- **Supabase**: 
  - PostgreSQL database with Row Level Security (RLS)
  - Authentication (OAuth, email/password)
  - Storage for images and profile photos
  - Real-time subscriptions

### Architecture
- Static web application with serverless backend
- Client-side routing and state management
- Modular CSS and JavaScript organization

## 📋 Prerequisites

- Node.js (optional, for local development)
- Supabase account and project
- Modern web browser (Chrome, Firefox, Safari, Edge)

## 🚀 Setup Instructions

### 1. Clone the Repository
```bash
git clone https://github.com/yourusername/gc-fitshare.git
cd gc-fitshare
```

### 2. Set Up Supabase

#### Create a Supabase Project
1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project URL and anon key from Settings > API

#### Run Database Migrations
Execute the SQL commands from `DATABASE_SCHEMA.md` in your Supabase SQL Editor:

```sql
-- Create tables
CREATE TABLE users (...);
CREATE TABLE posts (...);
CREATE TABLE comments (...);
CREATE TABLE post_likes (...);
CREATE TABLE reported_posts (...);
CREATE TABLE expert_applications (...);
CREATE TABLE counselling_bookings (...);
CREATE TABLE counselling_unavailable_dates (...);

-- Create indexes
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
-- ... (see DATABASE_SCHEMA.md for full schema)
```

#### Configure Storage
1. Create a storage bucket named `post-images`
2. Set up public read access and authenticated upload policies
3. Create a bucket named `profile-photos` for user avatars

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
SUPABASE_URL=your-supabase-project-url
SUPABASE_ANON_KEY=your-supabase-anon-key
```

### 4. Update Configuration

Edit the Supabase client initialization in your JavaScript files:

```javascript
const supabase = supabase.createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_SUPABASE_ANON_KEY'
);
```

### 5. Run the Application

#### Option A: Using a Local Server
```bash
# Using Python
python -m http.server 8000

# Using Node.js (http-server)
npx http-server

# Using PHP
php -S localhost:8000
```

#### Option B: Using Live Server (VS Code)
1. Install the "Live Server" extension
2. Right-click on `HTML/0_LandingPage.html`
3. Select "Open with Live Server"

### 6. Access the Application
Open your browser and navigate to:
- `http://localhost:8000/HTML/0_LandingPage.html` (Landing Page)
- `http://localhost:8000/HTML/2_Main_Feed.html` (Main Feed)

## 📁 Project Structure

```
GC FitShare/
├── HTML/
│   ├── 0_LandingPage.html          # Landing/Welcome page
│   ├── 1_LogIn_Page.html           # Authentication page
│   ├── 2_Main_Feed.html            # Main feed with posts
│   ├── 3_Profile.html              # User profile page
│   ├── 4_Expert_Application.html    # Expert application form
│   ├── 5_Info_Support.html         # Help and support center
│   ├── 6_Admin_Dashboard.html     # Admin moderation dashboard
│   └── 7_Guidance_Counselling.html # Counselling appointments
├── CSS/
│   ├── 0_AppBase.css              # Global styles and variables
│   ├── 2_Main_Feed.css            # Feed page styles
│   ├── 3_Profile.css              # Profile page styles
│   ├── 5_Info_Support.css         # Info & Support styles
│   ├── 6_Admin_Dashboard.css      # Admin dashboard styles
│   └── 7_Guidance_Counselling.css # Counselling page styles
├── JS/
│   ├── 0_Utilities.js             # Shared utility functions
│   ├── 0_Alerts.js                # Alert/notification system
│   ├── 0_AI_Moderation.js         # AI content moderation
│   ├── 0_Footer.js                # Footer components
│   ├── 2_Main_Feed.js             # Feed functionality
│   ├── 3_Profile.js               # Profile management
│   ├── 5_Info_Support.js          # Info & Support logic
│   ├── 6_Admin_Dashboard.js       # Admin panel logic
│   └── 7_Guidance_Counselling.js  # Counselling functionality
├── ASSETS/
│   └── BG/                        # Background images
├── DATABASE_SCHEMA.md             # Database schema documentation
├── DATABASE_GUIDANCE_COUNSELLING.md # Counselling schema docs
└── README.md                      # This file
```

## 🗄 Database Schema

The application uses the following main tables:

- **users**: User profiles and authentication data
- **posts**: Wellness posts with categories and moderation status
- **comments**: Nested comment threads for posts
- **post_likes**: User post interactions
- **reported_posts**: Content moderation reports
- **expert_applications**: Expert verification requests
- **counselling_bookings**: Guidance counselling appointments
- **counselling_unavailable_dates**: Counsellor availability management

For detailed schema information, see `DATABASE_SCHEMA.md` and `DATABASE_GUIDANCE_COUNSELLING.md`.

## 🔐 Security Features

- **Row Level Security (RLS)**: Database-level access control
- **Authentication**: Secure login with Supabase Auth
- **Content Moderation**: AI-powered content filtering
- **Admin Verification**: Admin-only features and moderation tools
- **Input Validation**: Client-side and server-side validation
- **XSS Protection**: Sanitized user inputs and outputs

## 🎨 Customization

### Theme Colors
Edit CSS variables in `CSS/0_AppBase.css`:

```css
:root {
    --primary-color: #1dd1a1;      /* Teal */
    --secondary-color: #0984e3;    /* Blue */
    --light-bg: #f5f6fa;           /* Light background */
    --card-bg: #ffffff;            /* Card background */
    --text-primary: #2d3436;       /* Primary text */
    --text-secondary: #636e72;     /* Secondary text */
    --border-color: #dfe6e9;       /* Border color */
}
```

### Categories
Add or modify wellness categories in the HTML and JavaScript files.

## 🐛 Troubleshooting

### Common Issues

**Issue**: "Error loading posts: column posts.status does not exist"
- **Solution**: Run the database migrations to add the `status` column to the `posts` table

**Issue**: Images not uploading
- **Solution**: Check Supabase storage bucket permissions and ensure the bucket exists

**Issue**: Authentication not working
- **Solution**: Verify your Supabase URL and anon key are correct in the configuration

**Issue**: CSS styles not loading
- **Solution**: Ensure CSS file paths are correct and files are in the proper directories

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow the existing code style and conventions
- Add comments for complex logic
- Test changes across different browsers
- Update documentation as needed

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 👥 Team

- **Developers**: [Your Name]
- **Institution**: Gordon College
- **Department**: Student Affairs / IT Department

## 🙏 Acknowledgments

- Supabase for the backend infrastructure
- Gordon College for supporting student wellness initiatives
- The open-source community for valuable resources and tools

## 📞 Support

For support or questions:
- Email: support@gordoncollege.edu
- GitHub Issues: [Create an issue](https://github.com/yourusername/gc-fitshare/issues)
- Documentation: See `DATABASE_SCHEMA.md` and inline code comments

## 🚀 Roadmap

### Planned Features
- [ ] Real-time chat between users
- [ ] Group challenges and competitions
- [ ] Wellness tracking and analytics
- [ ] Integration with campus systems
- [ ] Mobile app (React Native)
- [ ] Video content support
- [ ] Event calendar and registration
- [ ] Wellness resources library

---

**Built with ❤️ for Gordon College students**
