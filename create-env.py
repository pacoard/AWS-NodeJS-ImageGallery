#!/usr/bin/python

# Use example
# python create-env.py --key-pair mykey --security-group sg-rtw54sd --subnet-id subnet-56dfd21 --iam-role myRole
import os, argparse, json, random, time
# Measure how long the script takes
from datetime import datetime
startTime = datetime.now()


################################################
#											   #
# 	COMMAND CONFIGURATION WITH ARGUMENTPARSER  #
#											   #
################################################

parser = argparse.ArgumentParser(description="Script that automates the creation of ITMO544's MiniProject1 scenario.")
# python create-env.py --email 1 --key-pair 2 --security-group 3 --subnet-id 4 --iam-role 5
parser.add_argument('--notify-email', '-email', required=True, help="Email you want the notifications sent to.")
parser.add_argument('--key-pair', '-key', required=True, help="Name of the key pair to access the instances.")
parser.add_argument('--security-group', '-secgroup', required=True, help="ID of the security group that the instances will be in. Needs to open port 8000.")
parser.add_argument('--subnet-id', '-subnetid', required=True, help="ID of the subnet for the autoscaling group. You need to use the one assigned to us-east-2a.")
parser.add_argument('--iam-role', '-iamrole', required=True, help="Name of the IAM role that the EC2 instances will use. Needs to have PowerUserAccess permission.")

args = parser.parse_args()

print(args)
print('\n')


################################################
#											   #
# 	GLOBAL VALUES							   #
#											   #
################################################

# Local files for internal operations
AUX_FILE = 'auxfile.sh'
JSON_OUTPUT = 'output.json'
WEBAPP_REPOSITORY = 'https://github.com/pacoard/AWS-NodeJS-ImageGallery.git'
# AWS parameters
ELB_NAME = 'itmo544-elb'
ELB_DNS = '' # to be set when ELB is up and running
DASHBOARD_DNS = '' # to be set when the dashboard instance is launched
SQS_URL = '' # to be set when SQS is created
SNS_ARN = '' # to be set when SNS is created
AWS_KEY_PAIR = args.key_pair
SECURITY_GROUP = args.security_group
AVAILABILITY_ZONE = os.popen('aws configure get region').read().replace('\n', '')
AMI_ID = 'ami-78c1ee1d' # image of an instance that has nodejs installed and all the npm packages
IAM_ROLE = args.iam_role
SUBNET_ID = args.subnet_id
NOTIFICATION_EMAIL = args.notify_email
# Autoscaling parameters
AUTOSCALING_CONFIGURATION = 'itmo544-autoscaling-config'
AUTOSCALING_GROUP = 'itmo544-autoscaling-group'
# RDS values
RDS_ID = 'itmo544-rds-fgarciadelacorte'
RDS_HOST = '' # to be set when RDS is up and running
RDS_MASTER_USERNAME = 'fgarciadelacorte'
RDS_MASTER_PASSWORD = "".join(random.sample("abcdefghijklmnopqrstuvwxyz01234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",10)) # !@#$%^&*()? throw errors
RDS_DB_NAME = 'imagesdb'
# S3 bucket values
S3_BUCKET_NAME = 'itmo544-image-bucket-fgarciadelacorte'
# SNS values
SNS_TOPIC = 'itmo544-topic-fgarciadelacorte'

# GLOBAL FUNCTIONS
def execCommand(commandString):
	print('==========> Running command: ' + commandString + '\n')
	os.system(commandString)

def extractJSON():
	jsondict = {}
	with open(JSON_OUTPUT) as jsonfile:
		jsondict = json.load(jsonfile)
	os.remove(JSON_OUTPUT)
	return jsondict

# Create auxiliar file for commands to run when instances are created:
#	type: 'backend' or 'frontend' for running and installing the backend or the frontend
def createUserData(type):
	# Set Read-Replica URL for the dashboard app
	t_RDS_HOST = RDS_HOST.replace(RDS_ID, 'read1-'+RDS_ID) if (type == 'dashboard') else RDS_HOST

	fileData = (
		'#!/bin/bash\n'
		'cd /home/ubuntu\n'
		'runuser -l ubuntu -c \'git clone ' + WEBAPP_REPOSITORY + ' webapp\'\n'
		'cd ' + type + '\n'
		'cp /home/ubuntu/node_modules -r .\n'
		# PASSING DATA BY REPLACING VALUES IN THE SERVER SOURCE FILES
		"sed -i 's/t_AVAILABILITY_ZONE/\""+ AVAILABILITY_ZONE +"\"/g' server.js\n"
		"sed -i 's/t_SQS_URL/\""+ SQS_URL.replace('/', '\/') +"\"/g' server.js\n"
		"sed -i 's/t_SNS_ARN/\""+ SNS_ARN.replace('/', '\/') +"\"/g' server.js\n"
		"sed -i 's/t_S3_BUCKET_NAME/\""+ S3_BUCKET_NAME +"\"/g' server.js\n"
		"sed -i 's/t_DB_HOST/\""+ t_RDS_HOST +"\"/g' server.js\n"
		"sed -i 's/t_DB_USERNAME/\""+ RDS_MASTER_USERNAME +"\"/g' server.js\n"
		"sed -i 's/t_DB_PASSWORD/\""+ RDS_MASTER_PASSWORD +"\"/g' server.js\n"
		'npm start\n')
	print('=============================== ' + type + ' USER DATA FILE ===============================\n')
	print(fileData)
	print('==============================================================================\n')
	with open(AUX_FILE, 'w') as f:
		f.write(fileData)
	os.system('chmod +x ' + AUX_FILE)
	return AUX_FILE

################################################
#											   #
# 	S3 BUCKETS CREATION		                   #
#											   #
################################################

# First bucket for raw images
execCommand('aws s3api create-bucket'
			+ ' --bucket ' + S3_BUCKET_NAME
			+ ' --create-bucket-configuration LocationConstraint=' + AVAILABILITY_ZONE)

# Second bucket for processed images
execCommand('aws s3api create-bucket'
			+ ' --bucket post-' + S3_BUCKET_NAME
			+ ' --create-bucket-configuration LocationConstraint=' + AVAILABILITY_ZONE)


################################################
#											   #
# 	RDS DATABASE SETUP 						   #
#											   #
################################################

# Create RDS instance
execCommand('aws rds create-db-instance'
			+ ' --db-name ' + RDS_DB_NAME
			+ ' --db-instance-identifier ' + RDS_ID
			+ ' --db-instance-class db.t2.micro'
			+ ' --engine mysql'
			+ ' --allocated-storage 5'
			+ ' --backup-retention-period 1' # must be different from 0 to allow replication
			+ ' --vpc-security-group-ids ' + SECURITY_GROUP
			+ ' --master-username ' + RDS_MASTER_USERNAME
			+ ' --master-user-password ' + RDS_MASTER_PASSWORD
			+ ' --port 8000')

# Wait for RDS instance to be ready
execCommand('aws rds wait db-instance-available'
			+ ' --db-instance-identifier ' + RDS_ID)

# Create Read-Replica of the RDS (inherit all attributes from the source RDS)
execCommand('aws rds create-db-instance-read-replica'
			+ ' --db-instance-identifier read1-' + RDS_ID
			+ ' --source-db-instance-identifier ' + RDS_ID)

# Get RDS URL
execCommand('aws rds describe-db-instances > ' + JSON_OUTPUT)
RDS_HOST = extractJSON()['DBInstances'][0]['Endpoint']['Address']


################################################
#											   #
# 	QUEUEING AND NOTIFICATION SETUP	           #
#											   #
################################################

execCommand('aws sqs create-queue'
			+ ' --queue-name itmo544-queue'
			+ ' > ' + JSON_OUTPUT)
SQS_URL = extractJSON()['QueueUrl']

# SNS
execCommand('aws sns create-topic'
			+ ' --name ' + SNS_TOPIC
			+ ' > ' + JSON_OUTPUT)
SNS_ARN = extractJSON()['TopicArn']
execCommand('aws sns subscribe'
			+ ' --topic-arn ' + SNS_ARN
			+ ' --protocol email'
			+ ' --notification-endpoint ' + NOTIFICATION_EMAIL)


################################################
#											   #
# 	EC2 INSTANCES SETUP	                   	   #
#											   #
################################################

# Autoscaling launch configuration
execCommand('aws autoscaling create-launch-configuration'
			+ ' --launch-configuration-name ' + AUTOSCALING_CONFIGURATION
			+ ' --key-name ' + AWS_KEY_PAIR
			+ ' --security-groups ' + SECURITY_GROUP
			+ ' --iam-instance-profile ' + IAM_ROLE
			+ ' --image-id ' + AMI_ID
			+ ' --instance-type t2.micro'
			+ ' --user-data file://' + createUserData('frontend'))
# aws autoscaling create-launch-configuration --launch-configuration-name itmo544-autoscaling-config --key-name firstkeypair --security-groups sg-ca845ba2 --iam-instance-profile itmo544-ec2-role --image-id ami-78c1ee1d --instance-type t2.micro

# Autoscaling group creation
execCommand('aws autoscaling create-auto-scaling-group'
			+ ' --auto-scaling-group-name ' + AUTOSCALING_GROUP
			+ ' --launch-configuration-name ' + AUTOSCALING_CONFIGURATION
			+ ' --availability-zones ' + AVAILABILITY_ZONE + 'a'
			+ ' --desired-capacity 3'
			+ ' --min-size 1'
			+ ' --max-size 3'
			+ ' --vpc-zone-identifier ' + SUBNET_ID)
# aws autoscaling create-auto-scaling-group --auto-scaling-group-name itmo544-autoscaling-group --launch-configuration-name itmo544-autoscaling-config --desired-capacity 3 --min-size 1 --max-size 3

# Backend EC2 instance creation
execCommand('aws ec2 run-instances --image-id ' + AMI_ID
			+ ' --count 1'
			+ ' --instance-type t2.micro --key-name ' + AWS_KEY_PAIR
			+ ' --security-group-ids ' + SECURITY_GROUP
			+ ' --subnet-id ' + SUBNET_ID
			+ ' --iam-instance-profile Name=' + IAM_ROLE
			+ ' --tag-specifications ResourceType=instance,Tags=[{Key=Name,Value=Backend}]'
			+ ' --user-data file://' + createUserData('backend'))

# Dashboard EC2 instance creation (wrapped in a function so it's called later)
DASHBOARD_INSTANCE_ID = ''
def setDashboardInstance():
	# Wait for RDS instance to be ready
	execCommand('aws rds wait db-instance-available'
				+ ' --db-instance-identifier ' + RDS_ID)
	execCommand('aws ec2 run-instances --image-id ' + AMI_ID
				+ ' --count 1'
				+ ' --instance-type t2.micro --key-name ' + AWS_KEY_PAIR
				+ ' --security-group-ids ' + SECURITY_GROUP
				+ ' --subnet-id ' + SUBNET_ID
				+ ' --iam-instance-profile Name=' + IAM_ROLE
				+ ' --tag-specifications ResourceType=instance,Tags=[{Key=Name,Value=Dashboard}]'
				+ ' --user-data file://' + createUserData('dashboard')
				+ ' > ' + JSON_OUTPUT)

################################################
#											   #
# 	LOAD BALANCER SETUP	   			     	   #
#											   #
################################################

# Load balancer creation, with listener for the webapp
execCommand('aws elb create-load-balancer'
			+ ' --load-balancer-name ' + ELB_NAME
			+ ' --listeners "Protocol=HTTP,LoadBalancerPort=80,InstanceProtocol=HTTP,InstancePort=8000"'
			+ ' --availability-zones ' + AVAILABILITY_ZONE + 'a'
			+ ' --security-groups ' + SECURITY_GROUP
			+ ' > ' + JSON_OUTPUT)

ELB_DNS = extractJSON()['DNSName'] # get ELB's DNS in order to access the service

# Attach load balancer to the autoscaling group
execCommand('aws autoscaling attach-load-balancers'
			+ ' --load-balancer-names ' + ELB_NAME
			+ ' --auto-scaling-group-name ' + AUTOSCALING_GROUP)

# Create load balancer stickiness policy
execCommand('aws elb create-lb-cookie-stickiness-policy'
			+ ' --load-balancer-name ' + ELB_NAME
			+ ' --policy-name my-duration-cookie-policy'
			+ ' --cookie-expiration-period 60')

# Set policy
execCommand('aws elb set-load-balancer-policies-of-listener'
			+ ' --load-balancer-name ' + ELB_NAME
			+ ' --load-balancer-port 80'
			+ ' --policy-names my-duration-cookie-policy')



################################################
#											   #
# 	FINAL STEPS 			                   #
#											   #
################################################

# This way, the dashboard instance and the ELB are being set at the same time, and we save time
setDashboardInstance()
DASHBOARD_INSTANCE_ID = extractJSON()['Instances'][0]['InstanceId']

os.remove(AUX_FILE)

print('Waiting for the service to get up and running...')
execCommand('aws elb wait any-instance-in-service'
			' --load-balancer-name ' + ELB_NAME)

# Wait for the Dashboard instance to get up and running
print('Waiting for the service to get up and running...')
execCommand('aws ec2 wait instance-status-ok'
			' --instance-ids ' + DASHBOARD_INSTANCE_ID)
# Get DNS of Dashboard
execCommand('aws ec2 describe-instances' 
			+ ' --filters Name=instance-id,Values=' + DASHBOARD_INSTANCE_ID
			+ ' > ' + JSON_OUTPUT)
DASHBOARD_DNS = extractJSON()['Reservations'][0]['Instances'][0]['PublicDnsName']



################################################
#											   #
# 	END OF SCRIPT			                   #
#											   #
################################################

print('####################################################################################\n')
print('####################################################################################\n')
print('####################################################################################\n')
print('\n')

print('The service is ready to use. Go to the browser and use the ELB DNS address: \n')
print(ELB_DNS+'\n')
print('The dashboard\'s DNS address is: \n')
print(DASHBOARD_DNS + ':8000\n')
print('\n')
print('Execution time: ')
print(datetime.now() - startTime)